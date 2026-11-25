# The README demo: the published checker run against a live MCP server, read-only.
# Re-record: vhs docs/demo.tape (needs vhs; installs the pinned version in a temp folder first).
Output "docs/demo.gif"

Set Shell "bash"
Set FontSize 15
Set Width 1200
Set Height 1180
Set Padding 24
Set Theme "Builtin Dark"
Set TypingSpeed 35ms
Set Framerate 24

Hide
Type "export PS1='$ ' && D=$(mktemp -d) && cd $D && npm init -y >/dev/null && npm install --silent ${SCC_PKG:-mcp-server-card-check@0.7.1} >/dev/null 2>&1 && clear"
Enter
Wait@240s /^\$\s*$/
Show

Type "npx mcp-server-card-check https://context.faf.one/mcp"
Sleep 400ms
Enter
Wait+Screen@60s /no MUST failures/
Sleep 6s
