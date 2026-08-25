# Security

## Reporting

Before the public repository exists, report security issues privately to the
maintainer. After `xikhar/desk` is created, use GitHub private vulnerability
reporting rather than a public issue.

## Data boundary

Desk's automatic listeners calculate a numeric output level in memory. They
do not capture the microphone, write audio to disk, transcribe it, or send it
over the network.

The integration server binds only to `127.0.0.1`, rejects non-loopback `Host`
headers, restricts browser origins, and limits request bodies. Its event API
accepts only normalized state, level, and animation events. Its MCP API exposes
only closed animation, window, and status schemas; it cannot execute commands
or access arbitrary files.

The loopback MCP endpoint does not require authentication, so other processes
running on the same computer can invoke those visual controls. Tools that
handle sensitive data or broader system access must not be added without a
separate authorization design.

The renderer is sandboxed with context isolation and no Node.js integration. A
restrictive content security policy is applied, renderer popups are denied, and
navigation outside the local renderer entry is blocked.

## Supported versions

Until the first public release, only the current source revision is supported.
