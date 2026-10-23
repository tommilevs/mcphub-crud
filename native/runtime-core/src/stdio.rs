use std::collections::HashSet;
use std::io::{self, BufRead, BufReader, Write};
use std::process::{ChildStdin, ChildStdout};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Default)]
struct Health {
    unhealthy: bool,
    ready: bool,
    error: Option<String>,
    pending: HashSet<String>,
}
struct WriteRequest {
    message: String,
    deadline: Instant,
    reply: mpsc::Sender<io::Result<()>>,
}
pub type StdioEvents = mpsc::Receiver<io::Result<String>>;
#[derive(Clone)]
pub struct StdioSession {
    queue: mpsc::SyncSender<WriteRequest>,
    health: Arc<Mutex<Health>>,
    timeout: Duration,
    events: Arc<Mutex<Option<StdioEvents>>>,
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
        let (queue, writes) = mpsc::sync_channel::<WriteRequest>(8);
        let (output, events) = mpsc::sync_channel(256);
        let health = Arc::new(Mutex::new(Health::default()));
        let reader_health = Arc::clone(&health);
        std::thread::Builder::new()
            .name("mcphub-stdio-reader".into())
            .spawn(move || loop {
                let result = (|| {
                    let mut line = String::new();
                    if stdout.read_line(&mut line)? == 0 {
                        return Err(io::Error::new(
                            io::ErrorKind::UnexpectedEof,
                            "managed process closed stdout",
                        ));
                    }
                    let line = line.trim_end().to_string();
                    if let Ok(frame) = serde_json::from_str::<serde_json::Value>(&line) {
                        if frame["jsonrpc"] == "2.0"
                            && frame.get("method").is_none()
                            && (frame.get("result").is_some() || frame.get("error").is_some())
                        {
                            if let Some(id) = frame.get("id") {
                                let mut state =
                                    reader_health.lock().unwrap_or_else(|e| e.into_inner());
                                if state.pending.remove(&id.to_string())
                                    && frame.get("result").is_some()
                                    && !state.unhealthy
                                {
                                    state.ready = true;
                                }
                            }
                        }
                    }
                    Ok(line)
                })();
                let failed = result.is_err();
                if let Err(error) = &result {
                    fail(&reader_health, error);
                }
                if output.try_send(result).is_err() {
                    fail(
                        &reader_health,
                        &io::Error::other("stdio event consumer unavailable or queue full"),
                    );
                    break;
                }
                if failed {
                    break;
                }
            })?;
        let writer_health = Arc::clone(&health);
        std::thread::Builder::new()
            .name("mcphub-stdio-writer".into())
            .spawn(move || {
                while let Ok(request) = writes.recv() {
                    let result = (|| {
                        if Instant::now() >= request.deadline
                            || writer_health
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .unhealthy
                        {
                            return Err(io::Error::new(
                                io::ErrorKind::TimedOut,
                                "managed stdio write expired before execution",
                            ));
                        }
                        let frame: serde_json::Value = serde_json::from_str(&request.message)
                            .map_err(|_| io::Error::other("invalid MCP JSON-RPC frame"))?;
                        {
                            let mut state = writer_health.lock().unwrap_or_else(|e| e.into_inner());
                            if frame.get("method").is_some() {
                                if let Some(id) = frame.get("id") {
                                    if state.pending.len() >= 4096 {
                                        return Err(io::Error::other(
                                            "too many outstanding MCP requests",
                                        ));
                                    }
                                    state.pending.insert(id.to_string());
                                }
                            }
                            if frame["method"] == "notifications/cancelled" {
                                if let Some(id) = frame["params"].get("requestId") {
                                    state.pending.remove(&id.to_string());
                                }
                            }
                        }
                        stdin.write_all(request.message.as_bytes())?;
                        stdin.write_all(b"\n")?;
                        stdin.flush()?;
                        if Instant::now() >= request.deadline {
                            return Err(io::Error::new(
                                io::ErrorKind::TimedOut,
                                "managed stdio write deadline exceeded",
                            ));
                        }
                        Ok(())
                    })();
                    let failed = result.is_err();
                    if let Err(error) = &result {
                        fail(&writer_health, error);
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
            events: Arc::new(Mutex::new(Some(events))),
        })
    }
    pub(crate) fn health(&self) -> (bool, bool, Option<String>) {
        let state = self.health.lock().unwrap_or_else(|e| e.into_inner());
        (state.unhealthy, state.ready, state.error.clone())
    }
    /// Exactly one consumer owns the live stream; legacy exchanges cannot steal frames.
    pub fn take_events(&self) -> io::Result<StdioEvents> {
        self.events
            .try_lock()
            .map_err(|_| io::Error::other("stdio events are busy"))?
            .take()
            .ok_or_else(|| io::Error::other("stdio stream already leased"))
    }
    pub fn send_timeout(&self, message: &str, timeout: Duration) -> io::Result<()> {
        let timeout = timeout.clamp(Duration::from_millis(100), Duration::from_secs(3600));
        if self.health().0 {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "managed stdio session is no longer usable",
            ));
        }
        let (reply, response) = mpsc::channel();
        self.queue
            .try_send(WriteRequest {
                message: message.into(),
                deadline: Instant::now() + timeout,
                reply,
            })
            .map_err(|error| {
                io::Error::new(
                    io::ErrorKind::WouldBlock,
                    format!("managed stdio write queue unavailable: {error}"),
                )
            })?;
        match response.recv_timeout(timeout) {
            Ok(result) => result,
            Err(error) => {
                let source = io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!("managed stdio write timed out: {error}"),
                );
                fail(&self.health, &source);
                Err(source)
            }
        }
    }
    pub fn exchange(&self, message: &str) -> io::Result<Vec<String>> {
        self.exchange_timeout(message, self.timeout)
    }
    /// Compatibility path for older batch IPC clients. New clients use send + live events.
    pub fn exchange_timeout(&self, message: &str, timeout: Duration) -> io::Result<Vec<String>> {
        let timeout = timeout.clamp(Duration::from_millis(100), Duration::from_secs(3600));
        let deadline = Instant::now() + timeout;
        let incoming: serde_json::Value =
            serde_json::from_str(message).map_err(|_| io::Error::other("invalid MCP frame"))?;
        let locked = self
            .events
            .try_lock()
            .map_err(|_| io::Error::other("stdio exchange already active"))?;
        let events = locked
            .as_ref()
            .ok_or_else(|| io::Error::other("stdio stream is leased"))?;
        self.send_timeout(message, timeout)?;
        if incoming.get("method").is_none() || incoming.get("id").is_none() {
            return Ok(Vec::new());
        }
        let mut frames = Vec::new();
        loop {
            let result = events.recv_timeout(deadline.saturating_duration_since(Instant::now()));
            match result {
                Ok(Ok(frame)) => {
                    let matches = serde_json::from_str::<serde_json::Value>(&frame)
                        .ok()
                        .is_some_and(|value| {
                            value["jsonrpc"] == "2.0"
                                && value.get("id") == incoming.get("id")
                                && value.get("method").is_none()
                                && (value.get("result").is_some() || value.get("error").is_some())
                        });
                    frames.push(frame);
                    if matches {
                        return Ok(frames);
                    }
                }
                Ok(Err(error)) => return Err(error),
                Err(error) => {
                    let source = io::Error::new(
                        io::ErrorKind::TimedOut,
                        format!("managed stdio request timed out or disconnected: {error}"),
                    );
                    fail(&self.health, &source);
                    return Err(source);
                }
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
