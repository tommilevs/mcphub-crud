use std::path::PathBuf;
#[derive(Debug)]
pub struct Options {
    pub service_name: String,
    pub pipe_name: String,
    pub secret_dir: Option<PathBuf>,
    pub no_gateway: bool,
    pub gateway_port: u16,
    pub data_dir: Option<PathBuf>,
}
impl Options {
    pub fn parse(arguments: impl IntoIterator<Item = String>) -> Result<Self, String> {
        let mut options = Self {
            service_name: "MCPHub".into(),
            pipe_name: "mcphub-runtime".into(),
            secret_dir: None,
            no_gateway: false,
            gateway_port: 3000,
            data_dir: None,
        };
        let mut args = arguments.into_iter();
        while let Some(flag) = args.next() {
            match flag.as_str() {
                "--no-gateway" => options.no_gateway = true,
                "--service-name" | "--pipe-name" => {
                    let value = args
                        .next()
                        .ok_or_else(|| format!("missing value for {flag}"))?;
                    if value.is_empty()
                        || value.len() > 128
                        || !value
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
                    {
                        return Err(format!("invalid {flag}"));
                    }
                    if flag == "--service-name" {
                        options.service_name = value;
                    } else {
                        options.pipe_name = value;
                    }
                }
                "--gateway-port" => {
                    let port = args
                        .next()
                        .ok_or("missing gateway port")?
                        .parse::<u16>()
                        .map_err(|_| "invalid gateway port")?;
                    if port == 0 {
                        return Err("gateway port must be nonzero".into());
                    }
                    options.gateway_port = port;
                }
                "--secret-dir" | "--data-dir" => {
                    let path = PathBuf::from(args.next().ok_or("missing secret directory")?);
                    if !path.is_absolute() {
                        return Err("secret directory must be absolute".into());
                    }
                    if flag == "--secret-dir" {
                        options.secret_dir = Some(path);
                    } else {
                        options.data_dir = Some(path);
                    }
                }
                _ => return Err(format!("unknown runtime option: {flag}")),
            }
        }
        Ok(options)
    }
}
#[cfg(test)]
mod tests {
    use super::Options;
    fn parse(args: &[&str]) -> Result<Options, String> {
        Options::parse(args.iter().map(|value| value.to_string()))
    }
    #[test]
    fn production_defaults_remain_unchanged() {
        let options = parse(&[]).unwrap();
        assert_eq!(options.service_name, "MCPHub");
        assert_eq!(options.pipe_name, "mcphub-runtime");
        assert!(options.secret_dir.is_none());
        assert!(!options.no_gateway);
        assert_eq!(options.gateway_port, 3000);
        assert!(options.data_dir.is_none());
    }
    #[test]
    fn isolated_gateway_options_validate_port_and_absolute_data_path() {
        let options = parse(&["--gateway-port", "31337", "--data-dir", "C:\\MCPHub-test"]).unwrap();
        assert_eq!(options.gateway_port, 31337);
        assert_eq!(
            options.data_dir.unwrap(),
            std::path::PathBuf::from("C:\\MCPHub-test")
        );
        for args in [
            &["--gateway-port", "0"][..],
            &["--gateway-port", "65536"],
            &["--gateway-port", "abc"],
            &["--gateway-port"],
            &["--data-dir", "relative"],
            &["--data-dir"],
        ] {
            assert!(parse(args).is_err());
        }
    }
    #[test]
    fn diagnostic_instances_are_explicit_and_validate_identifiers() {
        let options = parse(&[
            "--service-name",
            "MCPHub-test",
            "--pipe-name",
            "mcphub-test",
            "--no-gateway",
        ])
        .unwrap();
        assert!(options.no_gateway);
        assert_eq!(options.service_name, "MCPHub-test");
        for args in [
            &["--pipe-name", "../other"][..],
            &["--service-name"],
            &["--secret-dir", "relative"],
            &["--unknown"],
        ] {
            assert!(parse(args).is_err());
        }
    }
}
