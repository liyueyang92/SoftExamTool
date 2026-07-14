"""视觉模型抽象层：支持 OpenAI-compatible / Anthropic / Ollama 多模态。"""

import base64
import hashlib
import json
import time
from pathlib import Path
from typing import Optional, Protocol, runtime_checkable

import httpx
from loguru import logger


@runtime_checkable
class VisionProvider(Protocol):
    """视觉模型接口协议。"""

    async def describe_image(
        self, image_path: str, prompt: str, *, temperature: float = 0.2
    ) -> str: ...


class OpenAICompatVisionProvider:
    """OpenAI-compatible 多模态接口（GPT-4V / 兼容服务）。"""

    def __init__(self, base_url: str, api_key: str, model: str):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.headers = {"Content-Type": "application/json"}
        if api_key.strip():
            self.headers["Authorization"] = f"Bearer {api_key.strip()}"

    async def describe_image(self, image_path: str, prompt: str, *, temperature: float = 0.2) -> str:
        with open(image_path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode()

        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(
                f"{self.base_url}/chat/completions",
                headers=self.headers,
                json={
                    "model": self.model,
                    "messages": [{
                        "role": "user",
                        "content": [
                            {"type": "text", "text": prompt},
                            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
                        ],
                    }],
                    "temperature": temperature,
                    "max_tokens": 2048,
                },
            )
            resp.raise_for_status()
            return resp.json()["choices"][0]["message"]["content"]


class AnthropicVisionProvider:
    """Anthropic 多模态接口（Claude 3+）。"""

    def __init__(self, api_key: str, model: str):
        self.model = model
        self.headers = {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        }

    async def describe_image(self, image_path: str, prompt: str, *, temperature: float = 0.2) -> str:
        with open(image_path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode()

        ext = Path(image_path).suffix.lower()
        media_type = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg"}.get(ext, "image/png")

        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(
                "https://api.anthropic.com/v1/messages",
                headers=self.headers,
                json={
                    "model": self.model,
                    "max_tokens": 2048,
                    "messages": [{
                        "role": "user",
                        "content": [
                            {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": b64}},
                            {"type": "text", "text": prompt},
                        ],
                    }],
                    "temperature": temperature,
                },
            )
            resp.raise_for_status()
            return resp.json()["content"][0]["text"]


class OllamaVisionProvider:
    """Ollama 多模态（需要支持 vision 的模型，如 llava / minicpm-v）。"""

    def __init__(self, base_url: str, model: str):
        self.base_url = base_url.rstrip("/")
        self.model = model

    async def describe_image(self, image_path: str, prompt: str, *, temperature: float = 0.2) -> str:
        with open(image_path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode()

        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(
                f"{self.base_url}/api/generate",
                json={
                    "model": self.model,
                    "prompt": prompt,
                    "images": [b64],
                    "stream": False,
                    "options": {"temperature": temperature},
                },
            )
            resp.raise_for_status()
            return resp.json()["response"]


def build_vision_provider(config: dict) -> Optional[VisionProvider]:
    """根据 AI 配置构建视觉模型提供者，若无法构建返回 None。"""
    mode = config.get("mode", "openai")

    if mode == "ollama":
        ollama = config.get("ollama", {})
        model = ollama.get("visionModel") or ollama.get("model", "")
        if not model:
            logger.warning("No vision model configured for Ollama")
            return None
        return OllamaVisionProvider(
            base_url=ollama.get("baseUrl", "http://localhost:11434"),
            model=model,
        )
    elif mode == "anthropic":
        anthropic = config.get("anthropic", {})
        api_key = anthropic.get("apiKey", "")
        if not api_key:
            logger.warning("No Anthropic API key configured")
            return None
        model = anthropic.get("visionModel") or anthropic.get("model", "claude-sonnet-4-6")
        return AnthropicVisionProvider(api_key=api_key, model=model)
    else:
        # openai-compatible mode
        openai = config.get("openai", {})
        api_key = openai.get("apiKey", "")
        model = openai.get("visionModel") or openai.get("model", "gpt-4o-mini")
        base_url = openai.get("baseUrl", "https://api.openai.com/v1")
        return OpenAICompatVisionProvider(base_url=base_url, api_key=api_key, model=model)


# ── 视觉摘要缓存 ──────────────────────────────────────────────────────────


def _cache_key(image_path: str, prompt: str, model: str) -> str:
    """基于图片路径 + prompt + 模型生成缓存键。"""
    content = f"{image_path}:{prompt}:{model}"
    return hashlib.sha256(content.encode()).hexdigest()


def _load_cached_summary(cache_dir: str, cache_key: str) -> Optional[str]:
    """从缓存目录加载缓存的摘要。"""
    cache_file = Path(cache_dir) / f"{cache_key}.json"
    if cache_file.exists():
        try:
            return json.loads(cache_file.read_text(encoding="utf-8"))["summary"]
        except Exception:
            return None
    return None


def _save_cached_summary(cache_dir: str, cache_key: str, summary: str) -> None:
    """将摘要缓存到磁盘。"""
    cache_dir_path = Path(cache_dir)
    cache_dir_path.mkdir(parents=True, exist_ok=True)
    (cache_dir_path / f"{cache_key}.json").write_text(
        json.dumps({"summary": summary, "cached_at": time.time()}, ensure_ascii=False),
        encoding="utf-8",
    )
