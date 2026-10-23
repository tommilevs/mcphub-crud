use std::io::{self, BufRead, BufReader, Write};
use std::process::{ChildStdin, ChildStdout};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Default)]
struct Health {
    unhealthy: bool,
    ready: bool,
    error: Option<String>,
}
struct Exchange {
    message: String,
    deadline: Instant,
    reply: mpsc::Sender<io::Result<Vec<String>>>,
}
#[derive(Clone)]
pub struct StdioSession {
    queue: mpsc::SyncSender<Exchange>,
    health: Arc<Mutex<Health>>,
    timeout: Duration,
}
impl StdioSession {
    pub(crate) fn record_failure(&self, message: &str) {
        fail(&self.health, &io::Error::other(message));
    }
    pub(crate) fn new(
        mut stdin: ChildStdin,
        mut stdout: BufReader<ChildStdout>,
        timeout: Duration,
    ) -> io::Result<Self> {
        let (queue, requests) = mpsc::sync_channel::<Exchange>(1);
        let health = Arc::new(Mutex::new(Health::default()));
        let worker_health = Arc::clone(&health);
        std::thread::Builder::new()
            .name("mcphub-managed-stdio".into())
            .spawn(move || {
                while let Ok(request) = requests.recv() {
                    let result = (|| {
                        if Instant::now() >= request.deadline
                            || worker_health
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .unhealthy
                        {
                            return Err(io::Error::new(
                                io::ErrorKind::TimedOut,
                                "managed stdio request expired before execution",
                            ));
                        }
                        let message: serde_json::Value = serde_json::from_str(&request.message)
                            .map_err(|_| io::Error::other("invalid MCP JSON-RPC frame"))?;
                        stdin.write_all(request.message.as_bytes())?;
                        stdin.write_all(b"\n")?;
                        stdin.flush()?;
                        if message.get("method").is_none() {
                            return Ok((Vec::new(), false));
                        }
                        let Some(expected) = message.get("id") else {
                            return Ok((Vec::new(), false));
                        };
                        let mut frames = Vec::new();
                        loop {
                            let mut line = String::new();
                            if stdout.read_line(&mut line)? == 0 {
                                return Err(io::Error::new(
                                    io::ErrorKind::UnexpectedEof,
                                    "managed process closed stdout",
                                ));
                            }
                            let frame = line.trim_end().to_owned();
                            let response = serde_json::from_str::<serde_json::Value>(&frame).ok();
                            let matches = response.as_ref().is_some_and(|value| {
                                value["jsonrpc"] == "2.0"
                                    && value.get("id") == Some(expected)
                                    && value.get("method").is_none()
                                    && (value.get("result").is_some()
                                        || value.get("error").is_some())
                            });
                            let successful = matches
                                && response
                                    .as_ref()
                                    .is_some_and(|value| value.get("result").is_some());
                            frames.push(frame);
                            if matches {
                                return Ok((frames, successful));
                            }
                        }
                    })();
                    let result = match result {
                        Ok((frames, successful)) => {
                            let mut state = worker_health.lock().unwrap_or_else(|e| e.into_inner());
                            if state.unhealthy || Instant::now() >= request.deadline {
                                Err(io::Error::new(
                                    io::ErrorKind::TimedOut,
                                    "managed stdio response arrived after its deadline",
                                ))
                            } else {
                                state.ready |= successful;
                                Ok(frames)
                            }
                        }
                        Err(error) => Err(error),
                    };
                    let failed = result.is_err();
                    if let Err(error) = &result {
                        fail(&worker_health, error);
                    }
                    let _ = request.reply.send(result);
                    if failed {
                        break;
                    }
                }
            })?;
        Ok(Self {
            queue,
            health,
            timeout,
        })
    }
    pub(crate) fn health(&self) -> (bool, bool, Option<String>) {
        let state = self.health.lock().unwrap_or_else(|e| e.into_inner());
        (state.unhealthy, state.ready, state.error.clone())
    }
    /// Wait outside the supervisor's lifecycle lock. A timed-out action is never replayed.
    pub fn exchange(&self, message: &str) -> io::Result<Vec<String>> {
        self.exchange_timeout(message, self.timeout)
    }
    pub fn exchange_timeout(&self, message: &str, timeout: Duration) -> io::Result<Vec<String>> {
        let timeout = timeout.clamp(Duration::from_millis(100), Duration::from_secs(3600));
        if self.health().0 {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "managed stdio session is no longer usable",
            ));
        }
        let (reply, response) = mpsc::channel();
        self.queue
            .try_send(Exchange {
                message: message.into(),
                deadline: Instant::now() + timeout,
                reply,
            })
            .map_err(|error| {
                io::Error::new(
                    io::ErrorKind::WouldBlock,
                    format!("managed stdio queue unavailable: {error}"),
                )
            })?;
        match response.recv_timeout(timeout) {
            Ok(value) => value,
            Err(error) => {
                let source = io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!("managed stdio request timed out or disconnected: {error}"),
                );
                fail(&self.health, &source);
                Err(source)
            }
        }
    }
}
fn fail(health: &Mutex<Health>, error: &io::Error) {
    let mut state = health.lock().unwrap_or_else(|e| e.into_inner());
    state.unhealthy = true;
    state.ready = false;
    state.error = Some(error.to_string().chars().take(1000).collect());
}
