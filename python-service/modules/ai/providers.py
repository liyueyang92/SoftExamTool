from typing import Any, Protocol, runtime_checkable
import httpx
from loguru import logger


class AIProviderError(RuntimeError):
    def __init__(self, message: str, *, status_code: int | None = None, retriable: bool = False):
        super().__init__(message)
        self.status_code = status_code
        self.retriable = retriable


@runtime_checkable
class AIProvider(Protocol):
    async def chat(self, messages: list[dict], temperature: float = 0.7) -> str: ...
    async def test_connection(self) -> str: ...


def _stringify_error_payload(payload: Any) -> str:
    if isinstance(payload, dict):
        for key in ('error', 'message', 'detail'):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
            if isinstance(value, dict):
                nested = _stringify_error_payload(value)
                if nested:
                    return nested
    elif isinstance(payload, list):
        for item in payload:
            nested = _stringify_error_payload(item)
            if nested:
                return nested
    elif isinstance(payload, str):
        return payload.strip()
    return ''


def _extract_error_detail(resp: httpx.Response) -> str:
    try:
        detail = _stringify_error_payload(resp.json())
        if detail:
            return detail
    except ValueError:
        pass

    text = resp.text.strip()
    if not text:
        return ''
    return text[:200]


def _build_http_error(context: str, resp: httpx.Response) -> RuntimeError:
    detail = _extract_error_detail(resp)
    suffix = f': {detail}' if detail else ''
    return AIProviderError(
        f'{context} failed with HTTP {resp.status_code}{suffix}',
        status_code=resp.status_code,
        retriable=resp.status_code == 429 or resp.status_code >= 500,
    )


def _build_request_error(context: str, exc: httpx.HTTPError) -> RuntimeError:
    return AIProviderError(f'{context} failed: {exc}', retriable=True)


def _extract_openai_text(payload: dict[str, Any]) -> str:
    choices = payload.get('choices')
    if not isinstance(choices, list) or not choices:
        raise ValueError('Missing choices in response')

    message = choices[0].get('message', {})
    content = message.get('content')
    if isinstance(content, str):
        return content

    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict) and item.get('type') == 'text' and isinstance(item.get('text'), str):
                parts.append(item['text'])
        if parts:
            return ''.join(parts)

    raise ValueError('Missing message content in response')


class OpenAICompatProvider:
    def __init__(self, base_url: str, api_key: str, model: str):
        self.base_url = base_url.rstrip('/')
        self.model = model
        normalized_api_key = api_key.strip()
        self.headers = {
            'Content-Type': 'application/json',
        }
        if normalized_api_key:
            self.headers['Authorization'] = f'Bearer {normalized_api_key}'

    def _url(self, path: str) -> str:
        return f'{self.base_url}{path}'

    async def chat(self, messages: list[dict], temperature: float = 0.7) -> str:
        async with httpx.AsyncClient(timeout=120.0) as client:
            try:
                resp = await client.post(
                    self._url('/chat/completions'),
                    headers=self.headers,
                    json={
                        'model': self.model,
                        'messages': messages,
                        'temperature': temperature,
                    },
                )
                resp.raise_for_status()
            except httpx.HTTPStatusError as exc:
                raise _build_http_error('OpenAI-compatible chat request', exc.response) from exc
            except httpx.HTTPError as exc:
                raise _build_request_error('OpenAI-compatible chat request', exc)

            return _extract_openai_text(resp.json())

    async def test_connection(self) -> str:
        model_warning = ''
        async with httpx.AsyncClient(timeout=30.0) as client:
            try:
                resp = await client.get(self._url('/models'), headers=self.headers)
                resp.raise_for_status()
            except httpx.HTTPStatusError as exc:
                if exc.response.status_code != 404:
                    raise _build_http_error('OpenAI-compatible model probe', exc.response) from exc
            except httpx.HTTPError as exc:
                raise _build_request_error('OpenAI-compatible model probe', exc)
            else:
                payload = resp.json()
                models = payload.get('data', []) if isinstance(payload, dict) else []
                model_ids = [
                    item.get('id')
                    for item in models
                    if isinstance(item, dict) and isinstance(item.get('id'), str)
                ]
                if model_ids and self.model not in model_ids:
                    logger.warning('Configured model {} not found in provider model list', self.model)
                    model_warning = f'Model "{self.model}" was not returned by /models'

        reply = await self.chat(
            [{'role': 'user', 'content': 'Reply with OK only.'}],
            temperature=0.0,
        )
        if not reply.strip():
            raise RuntimeError('OpenAI-compatible chat probe returned an empty reply')
        if model_warning:
            return f'Connected to {self.model}, but {model_warning}'
        return f'Connected to {self.model}'


class OllamaProvider:
    def __init__(self, base_url: str, model: str):
        self.base_url = base_url.rstrip('/')
        self.model = model

    async def chat(self, messages: list[dict], temperature: float = 0.7) -> str:
        async with httpx.AsyncClient(timeout=120.0) as client:
            try:
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
            except httpx.HTTPStatusError as exc:
                raise _build_http_error('Ollama chat request', exc.response) from exc
            except httpx.HTTPError as exc:
                raise _build_request_error('Ollama chat request', exc)

            return resp.json()['message']['content']

    async def test_connection(self) -> str:
        async with httpx.AsyncClient(timeout=30.0) as client:
            try:
                resp = await client.get(f'{self.base_url}/api/tags')
                resp.raise_for_status()
            except httpx.HTTPStatusError as exc:
                raise _build_http_error('Ollama model probe', exc.response) from exc
            except httpx.HTTPError as exc:
                raise _build_request_error('Ollama model probe', exc)

            payload = resp.json()
            models = payload.get('models', []) if isinstance(payload, dict) else []
            model_names = [
                item.get('name')
                for item in models
                if isinstance(item, dict) and isinstance(item.get('name'), str)
            ]
            if model_names and self.model not in model_names:
                return f'Connected, but model "{self.model}" is not available in Ollama'
            return f'Connected to {self.model}'


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
            try:
                resp = await client.post(
                    'https://api.anthropic.com/v1/messages',
                    headers=self.headers,
                    json=payload,
                )
                resp.raise_for_status()
            except httpx.HTTPStatusError as exc:
                raise _build_http_error('Anthropic chat request', exc.response) from exc
            except httpx.HTTPError as exc:
                raise _build_request_error('Anthropic chat request', exc)

            return resp.json()['content'][0]['text']

    async def test_connection(self) -> str:
        reply = await self.chat(
            [{'role': 'user', 'content': 'Reply with OK only.'}],
            temperature=0.0,
        )
        if not reply.strip():
            raise RuntimeError('Anthropic chat probe returned an empty reply')
        return f'Connected to {self.model}'


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
