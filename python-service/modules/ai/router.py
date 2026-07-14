import json
import re

from fastapi import APIRouter, HTTPException
from loguru import logger
from pydantic import BaseModel

from modules.ai.providers import AIProviderError, build_provider
from modules.question_bank_models import NewQuestionGroupModel

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
    target_group_id: str | None = None
    new_group: NewQuestionGroupModel | None = None


class GradeRequest(BaseModel):
    ai_config: dict
    question: str
    reference_points: str | None = None
    user_answer: str


class TestConnectionRequest(BaseModel):
    ai_config: dict


def _status_code_for_ai_error(exc: Exception) -> int:
    if isinstance(exc, AIProviderError) and exc.status_code:
        if 400 <= exc.status_code < 500:
            return exc.status_code
        return 502
    return 500


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

    try:
        raw = await provider.chat([
            {'role': 'system', 'content': GENERATE_SYSTEM_PROMPT},
            {'role': 'user', 'content': user_msg},
        ])
        result = extract_json(raw)
        questions = result.get('questions', [])
        if not questions:
            raise ValueError('No questions in response')
        return {
            'questions': questions,
            'target_group_id': req.target_group_id,
            'new_group': req.new_group.model_dump() if req.new_group else None,
        }
    except Exception as e:
        logger.warning('Question generation failed: {}', e)
        raise HTTPException(status_code=_status_code_for_ai_error(e), detail=f'AI 出题失败: {e}')


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
        reply = await provider.test_connection()
        return {'ok': True, 'reply': reply.strip()[:100]}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


ESSAY_SUGGEST_PROMPT = """你是软考系统架构设计师论文写作辅导专家。
用户正在写论文的某个段落，请根据段落名称和当前内容给出具体的写作建议。
要求：
1. 指出当前内容的不足（如果有）
2. 给出3-5条具体的改进建议
3. 建议要贴合软考论文的评分标准：技术深度、实践性、规范性
以简洁的中文回答，每条建议以"·"开头。"""

RAG_SYSTEM_PROMPT = """你是软考系统架构设计师备考助手，擅长软件架构、系统设计相关知识。
请根据提供的参考资料回答用户问题。如果参考资料与问题相关，优先使用参考资料的内容；
如果参考资料不相关或不足，可以补充你自己的专业知识。

注意：
- Markdown 表格应按行列关系理解，可用于回答对比、分类、特点类问题
- 图示摘要代表图片/流程图的内容，可用于回答结构、关系、层级类问题
- 回答时引用页码和内容类型，例如"参考：第14页表格"
- 如果参考资料不足以回答问题，请明确说明

回答时请用简洁清晰的中文。"""


class EssaySuggestRequest(BaseModel):
    ai_config: dict
    section_key: str
    section_label: str
    current_content: str
    word_target: int


@router.post('/essay-suggest')
async def essay_suggest(req: EssaySuggestRequest):
    provider = build_provider(req.ai_config)
    user_msg = (
        f'段落：{req.section_label}（目标字数约{req.word_target}字）\n'
        f'当前内容（{len(req.current_content.replace(chr(32), ""))}字）：\n{req.current_content[:1500]}'
    )
    try:
        reply = await provider.chat([
            {'role': 'system', 'content': ESSAY_SUGGEST_PROMPT},
            {'role': 'user', 'content': user_msg},
        ], temperature=0.7)
        return {'suggestions': reply.strip()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class ChatRequest(BaseModel):
    ai_config: dict
    question: str
    history: list[dict] = []
    doc_chunks: list[dict] = []   # [{content, page_num, doc_title, chunk_type?, asset_id?}]


@router.post('/chat')
async def ai_chat(req: ChatRequest):
    provider = build_provider(req.ai_config)

    context_text = ''
    if req.doc_chunks:
        parts = []
        for c in req.doc_chunks[:5]:
            chunk_type = c.get("chunk_type", "text")
            type_hint = {
                "table": "（以下为Markdown表格，请按行列关系理解）",
                "figure": "（以下为图片/流程图描述，可用于回答结构、分类、关系类问题）",
                "page_summary": "（以下为页面摘要）",
            }.get(chunk_type, "")

            parts.append(
                f'【第{c.get("page_num", "?")}页 · {c.get("doc_title", "文档")}'
                f' · {chunk_type}】{type_hint}\n'
                f'{c["content"][:800]}'
            )
        context_text = '\n\n---\n\n'.join(parts)

    messages = [{'role': 'system', 'content': RAG_SYSTEM_PROMPT}]
    for item in req.history[-12:]:
        role = item.get('role')
        content = item.get('content')
        if role in ('user', 'assistant') and isinstance(content, str) and content.strip():
            messages.append({'role': role, 'content': content.strip()})
    if context_text:
        messages.append({'role': 'user', 'content': f'参考资料：\n{context_text}\n\n问题：{req.question}'})
    else:
        messages.append({'role': 'user', 'content': req.question})

    try:
        reply = await provider.chat(messages, temperature=0.5)
        sources = [
            {
                'page_num': c.get('page_num'),
                'doc_title': c.get('doc_title', '文档'),
                'chunk_type': c.get('chunk_type', 'text'),
            }
            for c in req.doc_chunks[:5]
        ] if req.doc_chunks else []
        return {'answer': reply.strip(), 'sources': sources}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
