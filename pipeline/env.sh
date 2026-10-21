# pipeline/env.sh — 统一注入用户态工具链 PATH
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$ROOT/tools/mambaenv/bin:$ROOT/tools:$HOME/.cargo/bin:$PATH"
