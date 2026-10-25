//! Bounded installer jobs, separate from MCP stdio sessions and restart policy.
use crate::OwnedChild;
use std::{
    io,
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

#[derive(Debug, PartialEq, Eq)]
pub enum OneShotOutcome {
    Exited(Option<i32>),
    TimedOut,
    Cancelled,
}

/// The caller resolves a reviewed installer specification; this function owns
/// its entire Windows process tree and never returns raw installer output.
pub fn run_owned_command(
    command: &mut Command,
    timeout: Duration,
    cancel: &AtomicBool,
) -> io::Result<OneShotOutcome> {
    if timeout.is_zero() || timeout > Duration::from_secs(900) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid installer timeout",
        ));
    }
    if cancel.load(Ordering::Acquire) {
        return Ok(OneShotOutcome::Cancelled);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let start = Instant::now();
    let mut child = OwnedChild::spawn(command)?;
    loop {
        // A completed root still relinquishes its Job Object before returning,
        // so package scripts cannot leave detached descendants behind.
        if let Some(status) = child.try_wait()? {
            return Ok(OneShotOutcome::Exited(status.code()));
        }
        let reason = if cancel.load(Ordering::Acquire) {
            Some(OneShotOutcome::Cancelled)
        } else if start.elapsed() >= timeout {
            Some(OneShotOutcome::TimedOut)
        } else {
            None
        };
        if let Some(reason) = reason {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(reason);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
