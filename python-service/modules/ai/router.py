import json
import re

from fastapi import APIRouter, HTTPException
from loguru import logger
from pydantic import BaseModel

from modules.ai.providers import build_provider

router = APIRouter(prefix='/ai', tags=['ai'])

GENERATE_SYSTEM_PROMPT = """你是一个软考系统架构设计师考试出题专家。
根据用户要求生成符合软考风格的考试题目，以JSON格式输出。

输出格式（严格遵守）：
{
  "questions": [
    {
      "type": "single",          // single | multiple | case | essay
      "content": "题目正文",
      "options": ["A. 选项一", "B. 选项二", "C. 选项三", "D. 选项四"],  // essay/case时为null
      "answer": "A",             // essay时为null
      "explanation": "解析内容",
      "knowledge_tags": ["架构设计方法"],
      "difficulty": 3             // 1-5
    }
  ]
}

注意：
- 单选题必须有4个选项(A/B/C/D)，答案为单字母
- 多选题必须有4-6个选项，答案为逗号分隔的字母如"A,C"
- 案例题content为完整情景描述+问题，options和answer为null
- 论文题仅有content（题目要求），其余为null
- 只输出JSON，不要有任何其他内容
"""

GRADE_SYSTEM_PROMPT = """你是软考系统架构设计师考试阅卷专家。
请对给出的论文/案例答案进行评分，以JSON格式输出评分结果。

输出格式（严格遵守）：
{
  "total_score": 25,
  "dimension_scores": [
    {"name": "技术深度", "score": 8, "max_score": 10, "comment": "..."},
    {"name": "项目实践", "score": 7, "max_score": 8, "comment": "..."},
    {"name": "写作规范", "score": 5, "max_score": 5, "comment": "..."},
    {"name": "摘要质量", "score": 3, "max_score": 5, "comment": "..."},
    {"name": "字数充分", "score": 2, "max_score": 2, "comment": "..."}
  ],
  "feedback": "整体评语...",
  "suggestions": ["建议1", "建议2"]
}

只输出JSON，不要有任何其他内容。
"""


def extract_json(text: str) -> dict:
    # Try direct parse
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # Try extracting from markdown code block
    m = re.search(r'```(?:json)?\s*(\{.*?\})\s*```', text, re.DOTALL)
    if m:
        return json.loads(m.group(1))
    # Try finding JSON object in text
    m = re.search(r'\{.*\}', text, re.DOTALL)
    if m:
        return json.loads(m.group(0))
    raise ValueError(f'Cannot extract JSON from response: {text[:200]}')


class GenerateRequest(BaseModel):
    ai_config: dict
    count: int = 5
    types: list[str] = ['single']
    knowledge_tags: list[str] = []
    difficulty: int | None = None
    context: str | None = None  # Optional document context


class GradeRequest(BaseModel):
    ai_config: dict
    question: str
    reference_points: str | None = None
    user_answer: str


class TestConnectionRequest(BaseModel):
    ai_config: dict


@router.post('/generate-questions')
async def generate_questions(req: GenerateRequest):
    provider = build_provider(req.ai_config)

    type_desc = {
        'single': f'单选题{req.types.count("single")}道',
        'multiple': f'多选题{req.types.count("multiple")}道',
        'case': f'案例分析题{req.types.count("case")}道',
        'essay': f'论文题{req.types.count("essay")}道',
    }
    type_summary = '、'.join(v for k, v in type_desc.items() if req.types.count(k) > 0)

    tag_hint = f'知识点范围：{", ".join(req.knowledge_tags)}' if req.knowledge_tags else ''
    diff_hint = f'难度要求：{req.difficulty}级（1-5）' if req.difficulty else ''
    context_hint = f'\n\n参考材料：\n{req.context[:1000]}' if req.context else ''

    user_msg = f'请生成{type_summary}，共{req.count}题。{tag_hint} {diff_hint}{context_hint}'

    last_error = None
    for attempt in range(3):
        try:
            raw = await provider.chat([
                {'role': 'system', 'content': GENERATE_SYSTEM_PROMPT},
                {'role': 'user', 'content': user_msg},
            ])
            result = extract_json(raw)
            questions = result.get('questions', [])
            if not questions:
                raise ValueError('No questions in response')
            return {'questions': questions}
        except Exception as e:
            last_error = e
            logger.warning('Question generation attempt {} failed: {}', attempt + 1, e)

    raise HTTPException(status_code=500, detail=f'AI 出题失败（重试3次）: {last_error}')


@router.post('/grade-essay')
async def grade_essay(req: GradeRequest):
    provider = build_provider(req.ai_config)

    ref = f'\n评分要点：{req.reference_points}' if req.reference_points else ''
    user_msg = (
        f'题目：{req.question}{ref}\n\n'
        f'考生答案：\n{req.user_answer}'
    )

    last_error = None
    for attempt in range(3):
        try:
            raw = await provider.chat([
                {'role': 'system', 'content': GRADE_SYSTEM_PROMPT},
                {'role': 'user', 'content': user_msg},
            ], temperature=0.3)
            result = extract_json(raw)
            return result
        except Exception as e:
            last_error = e
            logger.warning('Essay grading attempt {} failed: {}', attempt + 1, e)

    raise HTTPException(status_code=500, detail=f'AI 评分失败: {last_error}')


@router.post('/test-connection')
async def test_connection(req: TestConnectionRequest):
    provider = build_provider(req.ai_config)
    try:
        reply = await provider.chat([
            {'role': 'user', 'content': '请回复"连接正常"，不要说其他内容。'},
        ], temperature=0.0)
        return {'ok': True, 'reply': reply.strip()[:100]}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
