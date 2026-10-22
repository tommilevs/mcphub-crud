# MCPHub native runtime

This workspace is the native foundation for the Windows release. `runtime-core`
supervises managed stdio MCP processes and restarts crashed children within a
bounded policy. On Windows every child is attached to a Job Object so the
service can terminate the full process tree. `service` currently exposes a
JSON-lines development transport; the Windows packaging phase replaces it with
SCM registration, a named pipe, Credential Manager/DPAPI-backed secret handles,
and the Tauri tray client.

The service receives resolved command specifications from MCPHub. It never reads
dashboard credentials from source files and never stores secrets in this crate.

