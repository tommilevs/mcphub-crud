//! Bounded asynchronous jobs. Package resolution and staging policy stay at IPC.
use mcphub_runtime_core::{run_owned_command_verified, OneShotOutcome};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

struct Job {
    binding: String,
    cancel: Arc<AtomicBool>,
    state: Arc<Mutex<Value>>,
}
#[derive(Default)]
pub struct InstallerJobs {
    jobs: Mutex<HashMap<String, Job>>,
}

pub(super) fn validate_request(id: &str, package: &str, version: &str) -> Result<(), &'static str> {
    let segment = |text: &str| {
        !text.is_empty()
            && text.as_bytes()[0].is_ascii_alphanumeric()
            && text
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
    };
    let valid_package = if let Some(scoped) = package.strip_prefix('@') {
        let parts: Vec<_> = scoped.split('/').collect();
        parts.len() == 2 && parts.iter().all(|part| segment(part))
    } else {
        segment(package)
    };
    let parts: Vec<_> = version.split('.').collect();
    let valid_version = version.len() <= 64
        && parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.bytes().all(|b| b.is_ascii_digit())
                && (part.len() == 1 || !part.starts_with('0'))
        });
    let valid_id = id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        });
    if !valid_id || !valid_package || package.len() > 214 || !valid_version {
        return Err("invalid pinned npm installer request");
    }
    Ok(())
}

pub fn start_npm(
    jobs: &InstallerJobs,
    id: &str,
    package: &str,
    version: &str,
    runtime: &std::path::Path,
    root: &std::path::Path,
) -> Result<Value, &'static str> {
    validate_request(id, package, version)?;
    let node = runtime.join("node.exe");
    let npm = runtime.join("npm").join("bin").join("npm-cli.js");
    if !node.is_file() || !npm.is_file() {
        return Err("bundled npm toolchain is unavailable");
    }
    let directory = root.join(id);
    let binding = format!("{package}@{version}");
    let mut command = Command::new(node);
    command
        .arg(npm)
        .args([
            "install",
            "--no-audit",
            "--no-fund",
            "--save-exact",
            "--global=false",
            &binding,
        ])
        .arg("--prefix")
        .arg(&directory)
        .current_dir(&directory);
    let mut paths = vec![runtime.to_path_buf()];
    if let Some(path) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&path));
    }
    command.env(
        "PATH",
        std::env::join_paths(paths).map_err(|_| "installer runtime path unavailable")?,
    );
    if jobs.status(id).is_ok() {
        return jobs.start(id, &binding, command);
    }
    std::fs::create_dir_all(root).map_err(|_| "installer staging root unavailable")?;
    // An existing directory may belong to an interrupted attempt. Never replay
    // package scripts after a restart merely because the memory registry is empty.
    std::fs::create_dir(&directory)
        .map_err(|_| "installer staging exists; reconciliation is required")?;
    std::fs::write(
        directory.join("operation.json"),
        json!({"id":id,"package":package,"version":version}).to_string(),
    )
    .map_err(|_| "installer staging marker could not be written")?;
    std::fs::write(
        directory.join("package.json"),
        r#"{"name":"mcphub-acquired-server","version":"0.0.0","private":true}"#,
    )
    .map_err(|_| "installer staging manifest could not be written")?;
    jobs.start(id, &binding, command)
}
impl InstallerJobs {
    /// Keep the registry and outcome locked during an ownership inspection.
    /// The callback must not reenter InstallerJobs. Terminal proof alone does
    /// not authorize deletion: publication/runtime/reference guards still apply.
    pub(super) fn with_terminal_job<T>(
        &self,
        id: &str,
        package: &str,
        version: &str,
        inspect: impl FnOnce(&Value) -> Result<T, &'static str>,
    ) -> Result<T, &'static str> {
        validate_request(id, package, version)?;
        let jobs = self.jobs.lock().map_err(|_| "installer jobs unavailable")?;
        let job = jobs
            .get(id)
            .ok_or("installer outcome is unknown; reconciliation is required")?;
        if job.binding != format!("{package}@{version}") {
            return Err("installer job identity conflict");
        }
        let state = job.state.lock().map_err(|_| "installer job unavailable")?;
        let terminal = match state["state"].as_str() {
            Some("cancelled" | "timed_out" | "failed") => true,
            Some("exited") => state["exitCode"].as_i64().is_some(),
            _ => false,
        };
        if !terminal || state["processExitConfirmed"] != true {
            return Err("installer has no confirmed terminal outcome");
        }
        inspect(&state)
    }
    pub fn start(
        &self,
        id: &str,
        binding: &str,
        mut command: Command,
    ) -> Result<Value, &'static str> {
        let mut jobs = self.jobs.lock().map_err(|_| "installer jobs unavailable")?;
        if let Some(job) = jobs.get(id) {
            if job.binding != binding {
                return Err("installer job identity conflict");
            }
            return job
                .state
                .lock()
                .map(|state| state.clone())
                .map_err(|_| "installer job unavailable");
        }
        if jobs.len() >= 64 {
            return Err("installer job registry is full; acknowledge completed jobs first");
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let state = Arc::new(Mutex::new(json!({"id":id,"state":"running"})));
        jobs.insert(
            id.into(),
            Job {
                binding: binding.into(),
                cancel: cancel.clone(),
                state: state.clone(),
            },
        );
        let job_id = id.to_owned();
        if std::thread::Builder::new()
            .name("mcphub-installer".into())
            .spawn(move || {
                let (result,confirmed)=match run_owned_command_verified(&mut command, Duration::from_secs(900), &cancel) {
                    Ok(result)=>(Ok(result.outcome),result.process_exit_confirmed),
                    Err(error)=>(Err(error),false),
                };
                let outcome = match result {
                    Ok(OneShotOutcome::Exited(code)) => {
                        json!({"id":job_id,"state":"exited","exitCode":code,"processExitConfirmed":confirmed})
                    }
                    Ok(OneShotOutcome::Cancelled) => json!({"id":job_id,"state":"cancelled","processExitConfirmed":confirmed}),
                    Ok(OneShotOutcome::TimedOut) => json!({"id":job_id,"state":"timed_out","processExitConfirmed":confirmed}),
                    Err(_) => {
                        json!({"id":job_id,"state":"failed","processExitConfirmed":false,"error":"installer process failed"})
                    }
                };
                if let Ok(mut state) = state.lock() {
                    *state = outcome;
                }
            })
            .is_err()
        {
            jobs.remove(id);
            return Err("installer worker could not start");
        }
        Ok(json!({"id":id,"state":"running"}))
    }
    pub fn status(&self, id: &str) -> Result<Value, &'static str> {
        let jobs = self.jobs.lock().map_err(|_| "installer jobs unavailable")?;
        let job = jobs.get(id).ok_or("installer job not found")?;
        let result = job
            .state
            .lock()
            .map(|state| state.clone())
            .map_err(|_| "installer job unavailable");
        result
    }
    pub fn cancel(&self, id: &str) -> Result<Value, &'static str> {
        let jobs = self.jobs.lock().map_err(|_| "installer jobs unavailable")?;
        let job = jobs.get(id).ok_or("installer job not found")?;
        job.cancel.store(true, Ordering::Release);
        Ok(json!({"id":id,"cancelRequested":true}))
    }
    pub fn forget(&self, id: &str) -> Result<Value, &'static str> {
        let mut jobs = self.jobs.lock().map_err(|_| "installer jobs unavailable")?;
        if let Some(job) = jobs.get(id) {
            if job.state.lock().map_err(|_| "installer job unavailable")?["state"] == "running" {
                return Err("installer job is still running");
            }
        }
        jobs.remove(id);
        Ok(json!({"ok":true}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cleanup_guard_requires_exact_identity_and_confirmed_terminal_outcome() {
        let jobs = InstallerJobs::default();
        let id = "00000000-0000-4000-8000-000000000001";
        let calls = std::cell::Cell::new(0);
        let inspect = |_: &Value| {
            assert!(
                jobs.jobs.try_lock().is_err(),
                "registry must stay locked during inspection"
            );
            calls.set(calls.get() + 1);
            Ok(())
        };
        assert!(jobs
            .with_terminal_job(id, "@fixture/mcp", "1.0.0", inspect)
            .is_err());
        jobs.jobs.lock().unwrap().insert(
            id.into(),
            Job {
                binding: "@fixture/mcp@1.0.0".into(),
                cancel: Arc::new(AtomicBool::new(false)),
                state: Arc::new(Mutex::new(json!({"state":"running"}))),
            },
        );
        assert!(jobs
            .with_terminal_job(id, "@fixture/mcp", "1.0.0", inspect)
            .is_err());
        for state in [
            json!({"state":"exited"}), json!({"state":"unknown"}),
            json!({"state":"failed","processExitConfirmed":false}),
            json!({"state":"cancelled"}),
            json!({"state":"exited","exitCode":0,"processExitConfirmed":false}),
        ] {
            *jobs.jobs.lock().unwrap()[id].state.lock().unwrap() = state;
            assert!(jobs
                .with_terminal_job(id, "@fixture/mcp", "1.0.0", inspect)
                .is_err());
        }
        assert_eq!(calls.get(), 0);
        for state in [
            json!({"state":"cancelled"}),
            json!({"state":"failed"}),
            json!({"state":"timed_out"}),
            json!({"state":"exited","exitCode":0}),
        ] {
            let mut state=state;
            state["processExitConfirmed"]=json!(true);
            *jobs.jobs.lock().unwrap()[id].state.lock().unwrap() = state;
            assert!(jobs
                .with_terminal_job(id, "@fixture/other", "1.0.0", inspect)
                .is_err());
            jobs.with_terminal_job(id, "@fixture/mcp", "1.0.0", inspect)
                .unwrap();
        }
        assert_eq!(calls.get(), 4);
        jobs.forget(id).unwrap();
        assert!(jobs
            .with_terminal_job(id, "@fixture/mcp", "1.0.0", inspect)
            .is_err());
    }
    fn fixture(script: &str) -> Command {
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
        ]);
        command
    }
    #[test]
    fn retries_bind_one_job_and_cancel_finishes_before_forget() {
        let jobs = InstallerJobs::default();
        jobs.start("fixture", "one", fixture("Start-Sleep -Seconds 30"))
            .unwrap();
        jobs.start("fixture", "one", fixture("exit 9")).unwrap();
        assert!(jobs.start("fixture", "other", fixture("exit 1")).is_err());
        assert!(jobs.forget("fixture").is_err());
        jobs.cancel("fixture").unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while jobs.status("fixture").unwrap()["state"] == "running" {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(jobs.status("fixture").unwrap()["state"], "cancelled");
        jobs.forget("fixture").unwrap();
        assert!(jobs.status("fixture").is_err());
    }

    #[test]
    fn pinned_adapter_uses_owned_directory_and_refuses_replay_after_registry_loss() {
        let location = Command::new("where.exe").arg("node.exe").output().unwrap();
        assert!(
            location.status.success(),
            "Node build toolchain is required for this fixture"
        );
        let node = String::from_utf8(location.stdout)
            .unwrap()
            .lines()
            .next()
            .unwrap()
            .trim()
            .to_owned();
        let temp = std::env::temp_dir();
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = temp.join(format!(
            "mcphub-installer-fixture-{}-{unique}",
            std::process::id()
        ));
        let runtime = root.join("runtime");
        std::fs::create_dir_all(runtime.join("npm/bin")).unwrap();
        std::fs::copy(node, runtime.join("node.exe")).unwrap();
        std::fs::write(
            runtime.join("npm/bin/npm-cli.js"),
            "require('fs').writeFileSync('observed.json',JSON.stringify(process.argv.slice(2))); ",
        )
        .unwrap();
        let jobs = InstallerJobs::default();
        let id = "00000000-0000-4000-8000-000000000001";
        let acquisitions = root.join("acquisitions");
        assert!(start_npm(&jobs, id, "fixture;exit", "1.0.0", &runtime, &acquisitions).is_err());
        assert!(!acquisitions.exists());
        start_npm(&jobs, id, "@fixture/mcp", "1.2.3", &runtime, &acquisitions).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        while jobs.status(id).unwrap()["state"] == "running" {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(jobs.status(id).unwrap()["exitCode"], 0);
        let inspection=crate::cleanup_path::inspect_owned_staging(
            &jobs,&acquisitions,id,"@fixture/mcp","1.2.3");
        if jobs.status(id).unwrap()["processExitConfirmed"]==true {
            assert_eq!(inspection.unwrap().0,acquisitions.join(id).canonicalize().unwrap());
        } else {
            assert_eq!(inspection.unwrap_err(),"installer has no confirmed terminal outcome");
        }
        let args: Value = serde_json::from_slice(
            &std::fs::read(acquisitions.join(id).join("observed.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            args,
            json!([
                "install",
                "--no-audit",
                "--no-fund",
                "--save-exact",
                "--global=false",
                "@fixture/mcp@1.2.3",
                "--prefix",
                acquisitions.join(id).to_string_lossy()
            ])
        );
        start_npm(&jobs, id, "@fixture/mcp", "1.2.3", &runtime, &acquisitions).unwrap();
        let restarted = InstallerJobs::default();
        assert!(crate::cleanup_path::inspect_owned_staging(
            &restarted,
            &acquisitions,
            id,
            "@fixture/mcp",
            "1.2.3"
        )
        .is_err());
        assert!(start_npm(
            &restarted,
            id,
            "@fixture/mcp",
            "1.2.3",
            &runtime,
            &acquisitions
        )
        .unwrap_err()
        .contains("reconciliation"));
        assert!(root.starts_with(&temp));
        assert!(root
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("mcphub-installer-fixture-"));
        std::fs::remove_dir_all(&root).unwrap();
        assert!(!root.exists());
    }
}
