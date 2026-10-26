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

/// Process execution and proof of an exhaustive shutdown are separate outcomes.
pub struct VerifiedOneShotOutcome {
    pub outcome: OneShotOutcome,
    pub process_exit_confirmed: bool,
}

/// Compatibility API. Its outcome alone does not authorize package cleanup.
pub fn run_owned_command(
    command: &mut Command, timeout: Duration, cancel: &AtomicBool,
) -> io::Result<OneShotOutcome> {
    run_owned_command_verified(command, timeout, cancel).map(|result| result.outcome)
}

/// The caller resolves a reviewed installer specification; this function owns
/// its entire Windows process tree and never returns raw installer output.
pub fn run_owned_command_verified(
    command: &mut Command,
    timeout: Duration,
    cancel: &AtomicBool,
) -> io::Result<VerifiedOneShotOutcome> {
    if timeout.is_zero() || timeout > Duration::from_secs(900) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid installer timeout",
        ));
    }
    if cancel.load(Ordering::Acquire) {
        return Ok(VerifiedOneShotOutcome {outcome:OneShotOutcome::Cancelled,process_exit_confirmed:true});
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let start = Instant::now();
    let mut child = OwnedChild::spawn(command)?;
    loop {
        // A completed root does not prove its descendants exited. Confirm the
        // entire job, rather than relying on asynchronous kill-on-close.
        if let Some(status) = child.try_wait()? {
            let confirmed=child.terminate_and_confirm()?;
            return Ok(VerifiedOneShotOutcome {outcome:OneShotOutcome::Exited(status.code()),process_exit_confirmed:confirmed});
        }
        let reason = if cancel.load(Ordering::Acquire) {
            Some(OneShotOutcome::Cancelled)
        } else if start.elapsed() >= timeout {
            Some(OneShotOutcome::TimedOut)
        } else {
            None
        };
        if let Some(reason) = reason {
            let confirmed=child.terminate_and_confirm()?;
            return Ok(VerifiedOneShotOutcome {outcome:reason,process_exit_confirmed:confirmed});
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
