"""
Accio API Interceptor — mitmproxy script
用法: mitmproxy -s accio_intercept.py

过滤并打印所有 Accio / Alibaba 后端 API 请求和响应
重点关注: phoenix-gw.alibaba.com / acs.h.accio.com / accio.com
"""

import json
import logging
from mitmproxy import http

# 只关注这些域名
TARGET_DOMAINS = [
    "phoenix-gw.alibaba.com",
    "acs.h.accio.com",
    "accio.com",
    "alibaba.com",
]

# 我们特别感兴趣的关键词（会加特殊标记）
HOT_PATHS = [
    "entitlement",
    "usage",
    "daily",
    "record",
    "quota",
    "point",
    "chart",
    "history",
    "stat",
]

logging.basicConfig(
    level=logging.INFO,
    format="%(message)s",
    handlers=[
        logging.StreamHandler(),
    ],
)
log = logging.getLogger("accio")


def _is_target(url: str) -> bool:
    # 临时去掉过滤，抓取所有流量，排查代理是否真正生效
    return True


def _is_hot(url: str) -> bool:
    return any(kw in url.lower() for kw in HOT_PATHS)


def request(flow: http.HTTPFlow) -> None:
    url = flow.request.pretty_url
    if not _is_target(url):
        return

    mark = "🔥" if _is_hot(url) else "  "
    log.info(f"\n{mark} ──────────────────────────────────────")
    log.info(f"{mark} [{flow.request.method}] {url}")

    # 打印关键请求头（脱敏 token）
    token = flow.request.headers.get("Authorization", "")
    if token:
        log.info(f"   Auth: {token[:20]}...")

    # 如果有请求体（POST）打印出来
    if flow.request.content:
        try:
            body = json.loads(flow.request.content)
            log.info(f"   Body: {json.dumps(body, ensure_ascii=False, indent=2)}")
        except Exception:
            log.info(f"   Body (raw): {flow.request.content[:200]}")


def response(flow: http.HTTPFlow) -> None:
    url = flow.request.pretty_url
    if not _is_target(url):
        return

    mark = "🔥" if _is_hot(url) else "  "
    status = flow.response.status_code
    log.info(f"{mark} ← HTTP {status}")

    # 只打印 JSON 响应体
    ct = flow.response.headers.get("content-type", "")
    if "json" in ct and flow.response.content:
        try:
            body = json.loads(flow.response.content)
            pretty = json.dumps(body, ensure_ascii=False, indent=2)
            # 截断超长响应
            if len(pretty) > 2000:
                pretty = pretty[:2000] + "\n... (truncated)"
            log.info(f"{mark} Response:\n{pretty}")
        except Exception:
            log.info(f"{mark} Response (raw): {flow.response.content[:500]}")
    log.info(f"{mark} ──────────────────────────────────────\n")
