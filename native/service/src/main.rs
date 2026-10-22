//! MCPHub service host. The Windows SCM wrapper and named-pipe IPC are kept at
//! this boundary so the supervisor core remains testable on every platform.

use mcphub_runtime_core::{ManagedProcessSpec, RuntimeSupervisor};
use std::{io::{self, BufRead}, thread, time::Duration};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut supervisor = RuntimeSupervisor::new();
    // stdin/stdout are the development transport; the Windows build replaces
    // this loop with a named-pipe endpoint and SCM service entrypoint.
    for line in io::stdin().lock().lines() {
        let line = line?;
        let request: serde_json::Value = serde_json::from_str(&line)?;
        match request.get("op").and_then(|value| value.as_str()) {
            Some("start") => {
                let spec: ManagedProcessSpec = serde_json::from_value(request["spec"].clone())?;
                println!("{}", serde_json::to_string(&supervisor.start(spec)?)?);
            }
            Some("stop") => { supervisor.stop(request["id"].as_str().unwrap_or_default())?; println!("{{\"ok\":true}}"); }
            Some("status") => println!("{}", serde_json::to_string(&supervisor.statuses())?),
            Some("shutdown") => break,
            _ => println!("{{\"error\":\"unknown operation\"}}"),
        }
        thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}

