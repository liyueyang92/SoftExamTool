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


# ─── Study Plan Overhaul: New AI endpoints ────────────────────────────────────

PLAN_ADVISOR_PROMPT = """你是软考系统架构设计师学习顾问，根据用户的真实学习数据给出个性化计划调整建议。
你需要：
1. 分析用户的知识点掌握情况（正确率数据）
2. 了解用户的学习习惯（近期学习时长和时段分布）
3. 结合考试剩余天数给出可操作的建议

回答要求：
- 基于提供的数据给出具体建议，不要泛泛而谈
- 指出最需要优先强化的3个薄弱知识点
- 给出一个小型的调整计划方案（未来3-5天）
- 语气鼓励但实事求是
- 如果数据不足，诚实说明并建议先多做练习"""

TEMPLATE_GENERATOR_PROMPT = """你是软考系统架构设计师备考计划专家。
根据用户的需求描述，生成一个学习计划模板。输出JSON格式：

{
  "name": "模板名称",
  "description": "模板描述",
  "phase": "foundation",
  "task_rules_json": {
    "daily_tasks": [
      {"type": "reading", "estimated_min": 90},
      {"type": "practice", "count": 15, "estimated_min": 30}
    ]
  }
}

task type取值：reading | video | practice | review | essay | mock_exam | custom
只输出JSON，不要有任何其他内容。"""

MATERIAL_MATCH_PROMPT = """你是知识关联专家。根据给定的知识点标签和用户的论文素材列表，
判断哪些素材与当前知识点相关，输出JSON：

{
  "matches": [
    {"material_id": "...", "relevance": 0.85, "summary": "该素材可用于论证..."}
  ]
}

relevance为0-1之间的浮点数。只输出JSON，不要有任何其他内容。"""

DAILY_RECOMMEND_PROMPT = """你是软考学习推荐引擎。根据用户今日任务列表和近期薄弱点，
推荐一个可选的额外学习任务。输出JSON：

{
  "recommended_task": {
    "task_type": "practice",
    "knowledge_tag": "微服务架构",
    "estimated_min": 30,
    "suggested_count": 10,
    "description": "额外练习"
  },
  "reason": "推荐理由..."
}

只输出JSON，不要有任何其他内容。"""


class PlanAdviceRequest(BaseModel):
    ai_config: dict
    exam_config: dict | None = None
    knowledge_domains: list[dict] = []
    tag_accuracy: list[dict] = []
    recent_logs: list[dict] = []
    question: str = ''


class GeneratePlanTemplateRequest(BaseModel):
    ai_config: dict
    description: str
    days_remaining: int = 60
    daily_hours: float = 2


class EssayMaterialMatchRequest(BaseModel):
    ai_config: dict
    knowledge_tag: str
    user_materials: list[dict] = []


class DailyRecommendationRequest(BaseModel):
    ai_config: dict
    today_tasks: list[dict] = []
    weak_tags: list[dict] = []
    recent_errors: list[dict] = []


class GenerateStudyPlanRequest(BaseModel):
    ai_config: dict
    exam_date: str                              # YYYY-MM-DD
    mode: str = 'normal'                        # normal | sprint
    domains: list[dict] = []                    # [{name, level, weight_pct, suggested_min}]
    daily_available_hours: float = 2.0
    weak_tags: list[str] = []                   # user's weak knowledge tags
    existing_progress: dict[str, float] = {}    # tag → accuracy rate


GENERATE_PLAN_PROMPT = """你是软考系统架构设计师考试备考计划专家。
根据用户提供的信息，为其生成一份完整的学习计划。

你需要输出一个JSON格式的学习计划，每天包含若干个任务。输出格式：

{
  "plan_name": "备考计划",
  "daily_schedule": [
    {
      "date": "2025-08-01",
      "phase": "foundation",
      "tasks": [
        {
          "knowledge_tag": "操作系统原理",
          "task_type": "reading",
          "estimated_min": 60,
          "suggested_count": 0,
          "priority": 0,
          "description": "阅读教材第3章等内容，理解进程调度算法"
        },
        {
          "knowledge_tag": "操作系统原理",
          "task_type": "practice",
          "estimated_min": 30,
          "suggested_count": 15,
          "priority": 1,
          "description": "练习进程管理相关选择题"
        }
      ]
    }
  ]
}

规划原则：
1. 分阶段递进——知识学习(foundation)→强化练习(reinforcement)→冲刺模考(sprint)
2. 知识点轮转——不同知识点交替安排，避免连续多天重复同一主题
3. 每周留1天缓冲——第7天、第14天等应该是复习日（task_type=review），不安排新内容
4. task_type取值：reading（阅读教材）、video（视频）、practice（练习题）、review（复习/案例）、essay（论文写作）、mock_exam（模拟考试）
5. 每天总任务时长不超过用户可用时间
6. 薄弱知识点（weak_tags中的）每天至少安排1个practice任务
7. 距考试剩余天数=30时进入sprint阶段，以mock_exam和review为主
8. 论文写作（essay）每周安排1-2次
9. 案例分析（review）从第二阶段开始每3天安排1次
10. priority：0=普通，1=重点，2=高优先级（薄弱环节），3=关键（冲刺阶段）

只输出JSON，不要有任何其他内容。"""


@router.post('/generate-plan')
async def generate_plan(req: GenerateStudyPlanRequest):
    from datetime import date as dt_date, timedelta

    provider = build_provider(req.ai_config)

    today = dt_date.today()
    exam = dt_date.fromisoformat(req.exam_date)
    days_left = max(1, (exam - today).days)

    domain_list = '\n'.join(
        f"- {d.get('name','')} (权重{d.get('weight_pct',0)}%, 建议{d.get('suggested_min',0)}分钟)"
        for d in req.domains[:20]
    ) if req.domains else '（无知识点数据，请根据软考系统架构设计师大纲自行安排）'

    weak_hint = ''
    if req.weak_tags:
        weak_hint = f'用户薄弱知识点（需重点练习）：{", ".join(req.weak_tags[:5])}'

    progress_hint = ''
    if req.existing_progress:
        prog = sorted(req.existing_progress.items(), key=lambda x: x[1])
        progress_hint = '知识点掌握情况：\n' + '\n'.join(
            f"- {tag}: {rate*100:.0f}%" for tag, rate in prog[:10]
        )

    is_sprint = req.mode == 'sprint' or days_left <= 30

    user_msg = (
        f"请为软考系统架构设计师考试生成一份{req.mode}模式的完整学习计划。\n\n"
        f"基本信息：\n"
        f"- 考试日期：{req.exam_date}\n"
        f"- 剩余天数：{days_left}天\n"
        f"- 每日可用时间：{req.daily_available_hours}小时\n"
        f"- 模式：{'冲刺模式' if is_sprint else '全面备考'}\n\n"
        f"知识点列表：\n{domain_list}\n\n"
        f"{weak_hint}\n\n"
        f"{progress_hint}\n\n"
        f"请从今天({today.isoformat()})开始安排，共{days_left}天。"
    )

    try:
        raw = await provider.chat([
            {'role': 'system', 'content': GENERATE_PLAN_PROMPT},
            {'role': 'user', 'content': user_msg},
        ], temperature=0.6)
        result = extract_json(raw)
        schedule = result.get('daily_schedule', [])
        return {
            'plan_name': result.get('plan_name', 'AI 备考计划'),
            'daily_schedule': schedule,
            'total_days': len(schedule),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f'AI 计划生成失败: {e}')


class OptimizePlanRequest(BaseModel):
    ai_config: dict
    daily_schedule: list[dict] = []     # current plan structure
    domains: list[dict] = []            # [{name, weight_pct}]
    daily_available_hours: float = 2.0  # hours per day
    exam_date: str = ''                 # YYYY-MM-DD


OPTIMIZE_PLAN_PROMPT = """你是软考系统架构设计师备考计划优化专家。
用户已经有一份由系统自动生成的学习计划，但这份计划可能存在以下问题：
1. 后半段出现和前半段完全重复的内容（因为生成了循环填充）
2. 知识点分布不够均匀，某些知识域连续多天安排
3. 任务类型单一，缺少变化
4. 阶段递进不明显

你的任务是审核这份计划，并输出优化后的完整版本。优化原则：
1. 移除明显的日期间重复（如果多个日期安排完全相同，后面的应该替换为其他知识域）
2. 确保知识域交替安排，同一知识域连续不超过2天
3. 任务类型多样化：reading/practice/review/essay/mock_exam 穿插
4. 分阶段递进：前面偏 reading+practice（基础），中间偏 practice+review（强化），末尾偏 mock_exam+review（冲刺）
5. 每周保留1天作为缓冲日（仅安排 review 或自定义轻量任务）
6. 每天总量不超过用户可用时间
7. 保留原有优秀安排，只修改有问题的部分

输出格式（严格遵守）：
{
  "daily_schedule": [
    {
      "date": "2025-08-01",
      "tasks": [
        {
          "knowledge_tag": "操作系统原理",
          "task_type": "reading",
          "estimated_min": 60,
          "suggested_count": 0,
          "priority": 0
        }
      ]
    }
  ]
}

task_type 取值：reading | practice | review | essay | mock_exam | custom
只输出 JSON，不要有任何其他内容。"""


@router.post('/optimize-plan')
async def optimize_plan(req: OptimizePlanRequest):
    from datetime import date as dt_date

    provider = build_provider(req.ai_config)

    # Summarize the current plan for AI review
    plan_summary_parts = []
    total_days = len(req.daily_schedule)
    for day in req.daily_schedule[:15]:  # Show first 15 days in detail
        date_str = day.get('date', '?')
        tasks = day.get('tasks', [])
        task_summary = '; '.join(
            f"{t.get('task_type','?')}:{t.get('knowledge_tag','?')}"
            for t in tasks
        )
        plan_summary_parts.append(f"  {date_str}: {task_summary}")

    # For remaining days, show only pattern summary
    if total_days > 15:
        plan_summary_parts.append(f"  ... 省略中间 {total_days - 30} 天 ...")
        for day in req.daily_schedule[-15:]:
            date_str = day.get('date', '?')
            tasks = day.get('tasks', [])
            task_summary = '; '.join(
                f"{t.get('task_type','?')}:{t.get('knowledge_tag','?')}"
                for t in tasks
            )
            plan_summary_parts.append(f"  {date_str}: {task_summary}")

    plan_summary = '\n'.join(plan_summary_parts)

    # Analyze repetition
    day_patterns = []
    for day in req.daily_schedule[:min(50, total_days)]:
        tasks = day.get('tasks', [])
        sig = '|'.join(sorted(
            f"{t.get('knowledge_tag','?')}|{t.get('task_type','?')}"
            for t in tasks
        ))
        day_patterns.append((day.get('date', '?'), sig))

    repeat_dates = []
    seen_patterns = {}
    for date_str, sig in day_patterns:
        if sig in seen_patterns:
            repeat_dates.append(f"  {date_str} 与 {seen_patterns[sig]} 完全相同")
        else:
            seen_patterns[sig] = date_str

    repeat_info = '\n'.join(repeat_dates[:10]) if repeat_dates else '（未检测到明显重复）'

    domain_list = '\n'.join(
        f"- {d.get('name','')} (权重{d.get('weight_pct',0)}%)"
        for d in req.domains[:20]
    ) if req.domains else '（无知识点数据）'

    try:
        exam = dt_date.fromisoformat(req.exam_date) if req.exam_date else None
    except ValueError:
        exam = None

    user_msg = (
        f"请审核并优化以下软考系统架构设计师学习计划。\n\n"
        f"计划概况：共 {total_days} 天"
        + (f"，考试日期 {req.exam_date}" if exam else "")
        + f"，每日可用 {req.daily_available_hours} 小时\n\n"
        f"当前计划摘要（最早+末尾各15天）：\n{plan_summary}\n\n"
        f"检测到的重复模式：\n{repeat_info}\n\n"
        f"可用知识域：\n{domain_list}\n\n"
        f"请输出优化后的完整 {total_days} 天计划（JSON格式）。"
    )

    try:
        raw = await provider.chat([
            {'role': 'system', 'content': OPTIMIZE_PLAN_PROMPT},
            {'role': 'user', 'content': user_msg},
        ], temperature=0.4)
        result = extract_json(raw)
        schedule = result.get('daily_schedule', [])
        if not schedule:
            raise ValueError('AI returned empty schedule')
        return {
            'daily_schedule': schedule,
            'total_days': len(schedule),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f'AI 计划优化失败: {e}')


@router.post('/plan-advice')
async def plan_advice(req: PlanAdviceRequest):
    provider = build_provider(req.ai_config)

    exam_info = ''
    if req.exam_config:
        exam_info = (
            f"\n考试名称：{req.exam_config.get('exam_name', '')}"
            f"\n考试日期：{req.exam_config.get('exam_date', '未设定')}"
            f"\n目标分数：{req.exam_config.get('target_score', '')}"
        )

    accuracy_info = ''
    if req.tag_accuracy:
        tags = sorted(req.tag_accuracy, key=lambda t: t.get('rate', 0))[:10]
        accuracy_info = '\n知识点正确率：\n' + '\n'.join(
            f"- {t['tag']}: {t['rate']*100:.0f}% ({t['total']}题)"
            for t in tags
        )

    logs_info = ''
    if req.recent_logs:
        total_min = sum(log.get('focus_minutes', 0) for log in req.recent_logs)
        logs_info = f'\n近{len(req.recent_logs)}天学习总时长：{total_min}分钟'

    user_msg = (
        f"用户学习数据：{exam_info}{accuracy_info}{logs_info}\n\n"
        f"用户问题：{req.question or '请根据以上数据给我学习建议'}"
    )

    try:
        reply = await provider.chat([
            {'role': 'system', 'content': PLAN_ADVISOR_PROMPT},
            {'role': 'user', 'content': user_msg},
        ], temperature=0.7)
        return {'advice': reply.strip(), 'suggested_tasks': []}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post('/generate-plan-template')
async def generate_plan_template(req: GeneratePlanTemplateRequest):
    provider = build_provider(req.ai_config)
    user_msg = (
        f"学习计划需求：{req.description}\n"
        f"剩余天数：{req.days_remaining}天\n"
        f"每日可用时长：{req.daily_hours}小时"
    )
    try:
        raw = await provider.chat([
            {'role': 'system', 'content': TEMPLATE_GENERATOR_PROMPT},
            {'role': 'user', 'content': user_msg},
        ], temperature=0.7)
        result = extract_json(raw)
        return {'template': result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post('/essay-material-match')
async def essay_material_match(req: EssayMaterialMatchRequest):
    provider = build_provider(req.ai_config)
    materials_str = '\n'.join(
        f"- ID:{m.get('id','')} 项目:{m.get('project_name','')} "
        f"背景:{m.get('background','')[:100]}"
        for m in req.user_materials[:10]
    )
    user_msg = f"知识点：{req.knowledge_tag}\n\n可用素材：\n{materials_str}"
    try:
        raw = await provider.chat([
            {'role': 'system', 'content': MATERIAL_MATCH_PROMPT},
            {'role': 'user', 'content': user_msg},
        ], temperature=0.3)
        result = extract_json(raw)
        return {'matches': result.get('matches', [])}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ─── Knowledge Extraction ──────────────────────────────────────────────────────

EXTRACT_KNOWLEDGE_PROMPT = """你是软考系统架构设计师知识大纲编制专家。
分析文档片段，提取已有领域树中不存在的知识点。最多提取6个。

要求：
1. 识别与软考系统架构设计师相关的知识点
2. 对照已有领域避免重复（名称相近也算重复）
3. 每个新知识点选最适合的已有父节点(suggested_parent_id)，全新方向用L1节点做父
4. name简短准确，summary限15字，confidence取1-5

只输出JSON：{"suggestions":[{"name":"名称","suggested_parent_id":"父ID","suggested_parent_name":"父名","summary":"15字摘要","source_chunk_ids":["chunk-id"],"confidence":4}]}"""


class KnowledgeExtractionRequest(BaseModel):
    ai_config: dict
    domain_tree: list = []       # [{id, name, level, children:[{id, name, level}]}]
    doc_chunks: list[dict] = []  # [{id, content, page_num}] — pre-truncated


@router.post('/extract-knowledge')
async def extract_knowledge(req: KnowledgeExtractionRequest):
    provider = build_provider(req.ai_config)

    def format_tree(nodes: list, indent: int = 0) -> list[str]:
        lines = []
        for n in nodes:
            prefix = '  ' * indent + ('- ' if indent > 0 else '★ ')
            lines.append(f"{prefix}[{n.get('id','?')}] {n.get('name','')}")
            if n.get('children'):
                lines.extend(format_tree(n['children'], indent + 1))
        return lines

    domain_tree_text = '\n'.join(format_tree(req.domain_tree)) if req.domain_tree \
        else '（暂无已有知识领域）'

    chunks_parts = []
    for c in req.doc_chunks[:25]:
        content = (c.get('content', '') or '')[:350].strip()
        if not content:
            continue
        chunks_parts.append(f"[{c.get('id','?')} p{c.get('page_num','?')}] {content}")

    if not chunks_parts:
        return {'suggestions': []}

    chunks_text = '\n---\n'.join(chunks_parts)

    user_msg = (
        f"已有领域（勿重复）：\n{domain_tree_text}\n\n"
        f"文档片段：\n{chunks_text}\n\n"
        f"最多提取6个新知识点。"
    )

    try:
        logger.info('AI extraction: {} chunks, {} domains', len(chunks_parts), len(req.domain_tree))
        raw = await provider.chat([
            {'role': 'system', 'content': EXTRACT_KNOWLEDGE_PROMPT},
            {'role': 'user', 'content': user_msg},
        ], temperature=0.3)
        result = extract_json(raw)
        suggestions = result.get('suggestions', [])
        logger.info('AI extraction: {} suggestions', len(suggestions))
        return {'suggestions': suggestions}
    except Exception as e:
        logger.warning('Knowledge extraction failed: {}', e)
        raise HTTPException(status_code=_status_code_for_ai_error(e),
                           detail=f'AI 知识点提取失败: {e}')


@router.post('/daily-recommendation')
async def daily_recommendation(req: DailyRecommendationRequest):
    provider = build_provider(req.ai_config)
    tasks_str = '\n'.join(
        f"- {t.get('task_type','')}: {t.get('knowledge_tag','')}"
        for t in req.today_tasks[:10]
    )
    weak_str = '\n'.join(
        f"- {t.get('tag','')}: 正确率{t.get('rate',0)*100:.0f}%"
        for t in req.weak_tags[:5]
    )
    user_msg = f"今日任务：\n{tasks_str}\n\n薄弱知识点：\n{weak_str}"
    try:
        raw = await provider.chat([
            {'role': 'system', 'content': DAILY_RECOMMEND_PROMPT},
            {'role': 'user', 'content': user_msg},
        ], temperature=0.7)
        result = extract_json(raw)
        return {
            'recommended_task': result.get('recommended_task', {}),
            'reason': result.get('reason', ''),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
