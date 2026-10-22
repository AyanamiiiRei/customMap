# pipeline/env.sh — 统一注入用户态工具链 PATH
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$ROOT/tools/mambaenv/bin:$ROOT/tools:$HOME/.cargo/bin:$PATH"

# 研究区 bbox（滇西北 + 川西）。改这里，所有步骤的默认值跟着走。
export REGION_BBOX="${REGION_BBOX:-96.0,24.6,105.0,35.0}"
