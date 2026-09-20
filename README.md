# code-prism-vs-code

VS Code extension for **Code Prism**.

Open a workspace → extension **auto-detects language** → loads SoT from  
`~/Library/Caches/code-prism/<lang>/<key>/` (not into the project).  
Unknown language → error. MCP is configured to **mcp-prism** with `PRISM_CWD` = this workspace.

## SoT (system cache)

```text
~/Library/Caches/code-prism/<lang>/<projectKey>/
  meta.json
  prism-context.json
  graph.sqlite
```

## Analyzer binary (Swift)

Build from [swift-prism](https://github.com/jokerphuongnam/swift-prism):

```bash
cd ../swift-prism/core && swift build -c release
mkdir -p ../code-prism-vs-code/bin
cp .build/release/swift-prism-analyzer ../code-prism-vs-code/bin/
```

Backends folder: `~/Documents/Code/code-prism/backends/`.

Other languages: [marlin-prism](https://github.com/jokerphuongnam/marlin-prism), [kotlin-prism](https://github.com/jokerphuongnam/kotlin-prism), [js-prism](https://github.com/jokerphuongnam/js-prism), [rust-prism](https://github.com/jokerphuongnam/rust-prism), [go-prism](https://github.com/jokerphuongnam/go-prism).

## Develop

```bash
npm install
# F5 → Run Extension
```

## Related

- [code-prism-app-mac](https://github.com/jokerphuongnam/code-prism-app-mac) — native macOS viewer  
- [swift-prism](https://github.com/jokerphuongnam/swift-prism) — Swift backend + MCP  
