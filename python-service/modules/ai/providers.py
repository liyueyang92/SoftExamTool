from typing import Protocol, runtime_checkable
import httpx
from loguru import logger


@runtime_checkable
class AIProvider(Protocol):
    async def chat(self, messages: list[dict], temperature: float = 0.7) -> str: ...


class OpenAICompatProvider:
    def __init__(self, base_url: str, api_key: str, model: str):
        self.base_url = base_url.rstrip('/')
        self.model = model
        self.headers = {
            'Authorization': f'Bearer {api_key}',
            'Content-Type': 'application/json',
        }

    async def chat(self, messages: list[dict], temperature: float = 0.7) -> str:
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(
                f'{self.base_url}/chat/completions',
                headers=self.headers,
                json={
                    'model': self.model,
                    'messages': messages,
                    'temperature': temperature,
                },
            )
            resp.raise_for_status()
            return resp.json()['choices'][0]['message']['content']


class OllamaProvider:
    def __init__(self, base_url: str, model: str):
        self.base_url = base_url.rstrip('/')
        self.model = model

    async def chat(self, messages: list[dict], temperature: float = 0.7) -> str:
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(
                f'{self.base_url}/api/chat',
                json={
                    'model': self.model,
                    'messages': messages,
                    'stream': False,
                    'options': {'temperature': temperature},
                },
            )
            resp.raise_for_status()
            return resp.json()['message']['content']


class AnthropicProvider:
    def __init__(self, api_key: str, model: str):
        self.model = model
        self.headers = {
            'x-api-key': api_key,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
        }

    async def chat(self, messages: list[dict], temperature: float = 0.7) -> str:
        system = None
        filtered = []
        for m in messages:
            if m.get('role') == 'system':
                system = m['content']
            else:
                filtered.append(m)

        payload: dict = {
            'model': self.model,
            'max_tokens': 4096,
            'messages': filtered,
            'temperature': temperature,
        }
        if system:
            payload['system'] = system

        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(
                'https://api.anthropic.com/v1/messages',
                headers=self.headers,
                json=payload,
            )
            resp.raise_for_status()
            return resp.json()['content'][0]['text']


def build_provider(config: dict) -> AIProvider:
    mode = config.get('mode', 'openai')
    if mode == 'ollama':
        ollama = config.get('ollama', {})
        return OllamaProvider(
            base_url=ollama.get('baseUrl', 'http://localhost:11434'),
            model=ollama.get('model', 'qwen2.5'),
        )
    elif mode == 'anthropic':
        anthropic_cfg = config.get('anthropic', {})
        return AnthropicProvider(
            api_key=anthropic_cfg.get('apiKey', ''),
            model=anthropic_cfg.get('model', 'claude-sonnet-4-6'),
        )
    else:
        openai_cfg = config.get('openai', {})
        return OpenAICompatProvider(
            base_url=openai_cfg.get('baseUrl', 'https://api.openai.com/v1'),
            api_key=openai_cfg.get('apiKey', ''),
            model=openai_cfg.get('model', 'gpt-4o-mini'),
        )
