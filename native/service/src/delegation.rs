/// Only process management and a new streaming lease may cross into a user agent.
/// Secret administration always stays in the machine service.
pub fn validate(request: &serde_json::Value, has_lease: bool) -> Result<(), &'static str> {
    if has_lease {
        return Err("interactive delegation requires a new connection");
    }
    match request["op"].as_str() {
        Some("start") if request["stream"] == true => Ok(()),
        Some("status" | "restart") => Ok(()),
        _ => Err("unsupported interactive operation"),
    }
}

#[cfg(test)]
mod tests {
    use super::validate;
    use serde_json::json;
    #[test]
    fn permits_explicit_status_and_restart() {
        for op in ["status", "restart"] {
            assert!(validate(&json!({"op":op}), false).is_ok());
        }
    }
    #[test]
    fn keeps_start_streaming_and_rejects_secret_and_shutdown_delegation() {
        assert!(validate(&json!({"op":"start","stream":true}), false).is_ok());
        for op in ["start", "secret_put", "secret_delete", "shutdown", "stop"] {
            assert!(validate(&json!({"op":op}), false).is_err());
        }
        assert!(validate(&json!({"op":"status"}), true).is_err());
    }
}
