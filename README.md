# code-prism-vs-code

VS Code extension for **Code Prism** — 3D graph visualization over a shared **SoT**.

This extension should treat language backends as plugins: analyze → write `<project>/.codeprism/`, then render. Prefer reading SoT over re-implementing parsers here.

## SoT

```text
<project>/.codeprism/
  prism-context.json
  graph.sqlite
```

Legacy: `.swiftprism/` still works if present.

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
