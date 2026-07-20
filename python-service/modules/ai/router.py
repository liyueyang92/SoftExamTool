import asyncio
import json
import re

from fastapi import APIRouter, HTTPException
from loguru import logger
from pydantic import BaseModel

from modules.ai.providers import AIProviderError, build_provider
from modules.ai.question_classifier import (
    aggregate_tags,
    classify_questions_batch,
    deduplicate_by_hierarchy,
)
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
    task_id: str = ''                           # optional WebSocket progress task id


GENERATE_PLAN_PARAMS_PROMPT = """你是软考系统架构设计师考试备考计划专家。
根据用户提供的信息，输出一份学习计划**参数**（不是逐天日程）。程序会根据参数自动生成完整的每日计划。

输出 JSON 格式（严格）：

{
  "plan_name": "备考计划名称",
  "domain_priorities": ["需要重点加强的知识域1", "知识域2"],
  "phase_ratios": [0.60, 0.25, 0.15],
  "task_type_mix": {
    "foundation":    {"reading": 50, "practice": 40, "review": 10},
    "reinforcement": {"practice": 40, "review": 30, "essay": 20, "reading": 10},
    "sprint":        {"mock_exam": 40, "review": 30, "practice": 20, "essay": 10}
  },
  "essay_interval": 5,
  "buffer_on": true,
  "buffer_interval": 7
}

字段说明：
- domain_priorities: 根据用户薄弱点，列出最需加强的 2-5 个知识域（用于增加出现频率）
- phase_ratios: 三阶段天数比例（基础/强化/冲刺），需 sum≈1.0
  · 正常模式(≥30天): [0.60, 0.25, 0.15]
  · 冲刺模式(<30天): [0.20, 0.40, 0.40]
- task_type_mix: 每阶段各任务类型占比（百分比，每个 phase 内 sum=100）
  · 若某个阶段的 mix 不需要修改，可省略该键（使用默认值）
- essay_interval: 论文写作间隔天数（阶段2+），3-7 天
- buffer_on: 是否每周安排 1 天缓冲日
- buffer_interval: 缓冲日间隔，通常 7 天

task_type 取值: reading | practice | review | essay | mock_exam | custom

规划原则：
1. 分阶段递进——基础(foundation)→强化(reinforcement)→冲刺(sprint)
2. 薄弱知识域放入 domain_priorities，系统会自动增加其出现频率
3. 每周留 1 天缓冲日，缓冲日以 review 为主
4. 冲刺阶段以 mock_exam + review 为主，减少 reading
5. 论文写作从强化阶段开始安排
6. 知识域轮转、避免连续重复、任务类型多样性等由程序自动保证

只输出 JSON，不要有其他内容。"""


@router.post('/generate-plan')
async def generate_plan(req: GenerateStudyPlanRequest):
    from datetime import date as dt_date
    from modules.progress import push_progress
    from modules.ai.schedule_builder import (
        ScheduleParams, build_schedule, params_from_ai_response, _domain_names,
    )

    provider = build_provider(req.ai_config)
    task_id = req.task_id

    async def _notify(progress: int, message: str):
        if task_id:
            await push_progress(task_id, progress, message)

    await _notify(5, '正在准备 AI 计划生成参数…')

    today = dt_date.today()
    exam = dt_date.fromisoformat(req.exam_date)
    days_left = max(1, (exam - today).days)
    daily_minutes = int(req.daily_available_hours * 60)
    is_sprint = req.mode == 'sprint' or days_left <= 30

    domain_list = '\n'.join(
        f"- {d.get('name','')} (权重{d.get('weight_pct',0)}%, 建议{d.get('suggested_min',0)}分钟)"
        for d in req.domains[:20]
    ) if req.domains else '（无知识点数据，请根据软考系统架构设计师大纲自行安排）'

    weak_hint = ''
    if req.weak_tags:
        weak_hint = f'\n用户薄弱知识点（需重点练习）：{", ".join(req.weak_tags[:5])}'

    progress_hint = ''
    if req.existing_progress:
        prog = sorted(req.existing_progress.items(), key=lambda x: x[1])
        progress_hint = '\n知识点掌握情况：\n' + '\n'.join(
            f"- {tag}: {rate*100:.0f}%" for tag, rate in prog[:10]
        )

    user_msg = (
        f"请为软考系统架构设计师考试生成一份学习计划参数。\n\n"
        f"基本信息：\n"
        f"- 考试日期：{req.exam_date}\n"
        f"- 剩余天数：{days_left} 天\n"
        f"- 每日可用时间：{req.daily_available_hours} 小时\n"
        f"- 模式：{'冲刺模式' if is_sprint else '全面备考'}\n"
        f"- 总可用时间：{days_left * daily_minutes} 分钟\n"
        f"\n知识域列表：\n{domain_list}"
        f"{weak_hint}{progress_hint}\n\n"
        f"请输出计划参数 JSON（非逐天计划）。"
    )

    # ── Build default params (fallback if AI fails) ──────────────────────
    if is_sprint:
        base_params = ScheduleParams.default_sprint(
            req.domains, days_left, daily_minutes, today.isoformat(),
        )
    else:
        base_params = ScheduleParams.default_normal(
            req.domains, days_left, daily_minutes, today.isoformat(),
        )
    if req.weak_tags:
        base_params.domain_priorities = [t for t in req.weak_tags if t in _domain_names(base_params)]

    await _notify(20, f'正在调用 AI 生成 {days_left} 天计划参数…（约 10-30 秒）')

    try:
        raw = await provider.chat([
            {'role': 'system', 'content': GENERATE_PLAN_PARAMS_PROMPT},
            {'role': 'user', 'content': user_msg},
        ], temperature=0.6)
        await _notify(60, 'AI 已返回参数，正在生成完整计划…')
        ai_json = extract_json(raw)

        # Merge AI params into base defaults
        params = params_from_ai_response(ai_json, base_params)

        # Build deterministic schedule
        schedule = build_schedule(params)
        await _notify(95, f'计划生成完成，共 {len(schedule)} 天任务')
        return {
            'plan_name': params.plan_name,
            'daily_schedule': schedule,
            'total_days': len(schedule),
        }
    except Exception as e:
        logger.warning('AI plan generation failed, using rule-based fallback: {}', e)
        # Fallback: use default params without AI
        try:
            schedule = build_schedule(base_params)
            await _notify(95, f'已使用默认参数生成 {len(schedule)} 天计划')
            return {
                'plan_name': base_params.plan_name,
                'daily_schedule': schedule,
                'total_days': len(schedule),
            }
        except Exception as e2:
            if task_id:
                await push_progress(task_id, 0, f'AI 计划生成失败: {e2}')
            raise HTTPException(status_code=500, detail=f'AI 计划生成失败: {e2}')


class OptimizePlanRequest(BaseModel):
    ai_config: dict
    daily_schedule: list[dict] = []     # current plan structure
    domains: list[dict] = []            # [{name, weight_pct}]
    daily_available_hours: float = 2.0  # hours per day
    exam_date: str = ''                 # YYYY-MM-DD
    task_id: str = ''                   # optional WebSocket progress task id


OPTIMIZE_PLAN_PARAMS_PROMPT = """你是软考系统架构设计师备考计划优化专家。
你会收到一份当前计划的**统计摘要**（非逐天日程），请分析问题并输出**优化参数**。

程序会根据你的参数自动重新生成完整的每日计划——你不需要输出逐天 JSON。

输出 JSON 格式（严格）：

{
  "plan_name": "优化后的计划名称",
  "domain_priorities": ["需优先加强的知识域1", "知识域2"],
  "phase_ratios": [0.60, 0.25, 0.15],
  "task_type_mix": {
    "foundation":    {"reading": 50, "practice": 40, "review": 10},
    "reinforcement": {"practice": 40, "review": 30, "essay": 20, "reading": 10},
    "sprint":        {"mock_exam": 40, "review": 30, "practice": 20, "essay": 10}
  },
  "essay_interval": 5,
  "buffer_on": true,
  "highlights": ["优化要点1", "优化要点2", "优化要点3"]
}

优化指导：
1. domain_priorities: 根据知识域覆盖统计，标注权重偏高或偏少的域（最多 3 个）
2. phase_ratios: 调整阶段天数比例使各阶段任务类型分布合理
3. task_type_mix: 修复阶段吻合度问题——基础阶段不应有论文/模考，冲刺阶段模考应占主导
4. 根据统计中的"同域连续问题"调整 max_consecutive（程序自动保证≤2）
5. 根据"每日负载统计"调整任务数——空白天补内容，超载天减任务
6. 论文/案例分析偏少时增加 essay_interval 或 task_type_mix 中的占比
7. highlights: 3-5 条简洁的优化要点（中文），用于 UI 预览展示

只输出 JSON，不要有其他内容。"""


def _compute_changes_summary(original: list[dict], optimized: list[dict]) -> dict:
    """Compare original and optimized daily schedules, returning a structured summary."""
    from collections import Counter

    total_days = max(len(original), len(optimized))
    if total_days == 0:
        return {
            'total_days': 0, 'days_changed': 0, 'duplicates_removed': 0,
            'task_type_counts_before': {}, 'task_type_counts_after': {},
            'domain_count_before': 0, 'domain_count_after': 0,
            'highlights': ['计划为空'], 'sample_changes': [],
        }

    orig_map = {d.get('date', ''): d for d in original}
    opt_map = {d.get('date', ''): d for d in optimized}
    orig_dates = set(orig_map.keys())
    opt_dates = set(opt_map.keys())

    # Days changed
    days_changed = 0
    sample_changes: list[dict] = []
    for date in opt_dates:
        orig_fp = _day_fingerprint(orig_map.get(date, {}))
        opt_fp = _day_fingerprint(opt_map.get(date, {}))
        if orig_fp != opt_fp:
            days_changed += 1
            if len(sample_changes) < 5:
                orig_doms = {t.get('knowledge_tag', '') for t in orig_map.get(date, {}).get('tasks', []) if t.get('knowledge_tag')}
                opt_doms = {t.get('knowledge_tag', '') for t in opt_map.get(date, {}).get('tasks', []) if t.get('knowledge_tag')}
                sample_changes.append({
                    'date': date,
                    'added_domains': list(opt_doms - orig_doms)[:3],
                    'removed_domains': list(orig_doms - opt_doms)[:3],
                })
    # Also count dates that only exist in original (removed days)
    for date in orig_dates - opt_dates:
        days_changed += 1

    # Duplicates removed
    orig_fps = [_day_fingerprint(d) for d in original]
    dup_count = max(0, len([fp for fp, c in Counter(orig_fps).items() if c >= 2]))

    # Task type distribution
    def _tt_counts(schedule: list[dict]) -> dict[str, int]:
        c: dict[str, int] = Counter()
        for day in schedule:
            for t in day.get('tasks', []):
                c[t.get('task_type', 'practice')] += 1
        return dict(c)

    before_types = _tt_counts(original)
    after_types = _tt_counts(optimized)

    # Domain diversity
    def _all_domains(schedule: list[dict]) -> int:
        domains: set[str] = set()
        for day in schedule:
            for t in day.get('tasks', []):
                if t.get('knowledge_tag'):
                    domains.add(t['knowledge_tag'])
        return len(domains)

    before_dc = _all_domains(original)
    after_dc = _all_domains(optimized)

    # Highlights
    highlights: list[str] = []
    if dup_count > 0:
        highlights.append(f'消除了 {dup_count} 组重复的日计划模式')
    else:
        highlights.append('未检测到明显的日期间重复')

    pct = max(0, round(days_changed / total_days * 100)) if total_days > 0 else 0
    highlights.append(f'共调整了 {days_changed}/{total_days} 天的计划安排（{pct}%）')

    for tt, label in [('essay', '论文写作'), ('review', '复习/案例分析'), ('mock_exam', '模拟考试')]:
        before = before_types.get(tt, 0)
        after = after_types.get(tt, 0)
        if after != before:
            delta = after - before
            highlights.append(f'{label}：{before} → {after} 次（{"+" if delta > 0 else ""}{delta}）')

    if after_dc > before_dc:
        highlights.append(f'知识域覆盖从 {before_dc} 个增加到 {after_dc} 个')

    return {
        'total_days': total_days,
        'days_changed': days_changed,
        'duplicates_removed': dup_count,
        'task_type_counts_before': before_types,
        'task_type_counts_after': after_types,
        'domain_count_before': before_dc,
        'domain_count_after': after_dc,
        'highlights': highlights,
        'sample_changes': sample_changes,
    }


@router.post('/optimize-plan')
async def optimize_plan(req: OptimizePlanRequest):
    from datetime import date as dt_date, timedelta
    from modules.progress import push_progress
    from modules.ai.schedule_builder import (
        ScheduleParams, build_schedule, params_from_ai_response,
    )

    provider = build_provider(req.ai_config)
    task_id = req.task_id

    async def _notify(progress: int, message: str):
        if task_id:
            await push_progress(task_id, progress, message)

    await _notify(5, '正在分析当前计划结构…')

    total_days = len(req.daily_schedule)
    daily_budget_min = req.daily_available_hours * 60

    # ── Full-plan statistical summary ───────────────────────────────────
    await _notify(8, '正在提取全量计划统计…')
    stats_text = _build_plan_statistics(
        req.daily_schedule, req.domains, req.daily_available_hours,
    )

    # ── Strategic sampling ──────────────────────────────────────────────
    await _notify(12, '正在采样代表性日期…')
    samples_text = _strategic_samples(req.daily_schedule, n=8)

    # ── Full-plan repetition analysis ───────────────────────────────────
    await _notify(16, '正在检测全量重复模式…')
    repeat_text = _full_repetition_analysis(req.daily_schedule)

    # ── Domain list ─────────────────────────────────────────────────────
    domain_list = '\n'.join(
        f"- {d.get('name','')} (权重{d.get('weight_pct',0)}%)"
        for d in req.domains[:20]
    ) if req.domains else '（无知识点数据）'

    # ── Phase hint ──────────────────────────────────────────────────────
    try:
        exam = dt_date.fromisoformat(req.exam_date) if req.exam_date else None
    except ValueError:
        exam = None

    today_date = dt_date.today()
    days_to_exam = (exam - today_date).days if exam else None
    phase_hint = (
        f"\n当前计划共 {total_days} 天"
        + (f"，考试日期 {req.exam_date}（还剩 {days_to_exam} 天）" if exam else "")
        + f"，每日可用 {req.daily_available_hours} 小时\n"
    )

    # ── Build base params — use days_to_exam (from exam_date) as authoritative,
    #    not the old schedule length (which may be truncated)
    target_days = days_to_exam if days_to_exam and days_to_exam > 0 else total_days
    base_params = ScheduleParams(
        domains=req.domains,
        total_days=target_days,
        daily_minutes=int(daily_budget_min),
        start_date=(req.daily_schedule[0].get('date', '') if req.daily_schedule else ''),
    )

    # ── Assemble AI prompt ──────────────────────────────────────────────
    user_msg = (
        f"请审核以下软考学习计划并输出优化参数。\n\n"
        + phase_hint
        + f"\n{'─' * 40}\n📊 全量统计摘要（覆盖全部 {total_days} 天）\n{'─' * 40}\n"
        + stats_text
        + f"\n\n{'─' * 40}\n📅 代表性日期采样\n{'─' * 40}\n"
        + samples_text
        + f"\n\n{'─' * 40}\n🔁 重复模式检测（全量）\n{'─' * 40}\n"
        + repeat_text
        + f"\n\n{'─' * 40}\n📚 可用知识域\n{'─' * 40}\n"
        + domain_list
        + f"\n\n请输出优化参数 JSON（非逐天计划）。"
    )

    display_days = days_to_exam if days_to_exam and days_to_exam > 0 else total_days
    await _notify(25, f'正在调用 AI 优化 {display_days} 天计划…（约 20-40 秒）')

    try:
        raw = await provider.chat([
            {'role': 'system', 'content': OPTIMIZE_PLAN_PARAMS_PROMPT},
            {'role': 'user', 'content': user_msg},
        ], temperature=0.4)
        await _notify(60, 'AI 已返回优化参数，正在生成新计划…')
        ai_json = extract_json(raw)

        # Merge AI params into base
        params = params_from_ai_response(ai_json, base_params)

        # Build new schedule
        schedule = build_schedule(params, seed=hash(req.exam_date or '') % 10000 or 42)
        await _notify(88, '正在对比优化前后的变化…')
        changes_summary = _compute_changes_summary(req.daily_schedule, schedule)

        # Inject AI highlights into the summary
        if 'highlights' in ai_json and isinstance(ai_json['highlights'], list):
            changes_summary['highlights'] = ai_json['highlights']

        await _notify(95, f'优化完成，共 {len(schedule)} 天任务')
        return {
            'daily_schedule': schedule,
            'total_days': len(schedule),
            'changes_summary': changes_summary,
        }
    except Exception as e:
        logger.warning('AI optimization failed: {}', e)
        if task_id:
            await push_progress(task_id, 0, f'AI 计划优化失败: {e}')
        raise HTTPException(status_code=500, detail=f'AI 计划优化失败: {e}')


# ─── Optimize-plan helpers (stats & analysis for AI prompt) ──────────────────────

def _day_fingerprint(day: dict) -> str:
    """Generate a stable signature for a single day's task arrangement."""
    tasks = day.get('tasks', [])
    return '|'.join(sorted(
        f"{t.get('knowledge_tag','?')}|{t.get('task_type','?')}"
        for t in tasks
    ))


def _build_plan_statistics(schedule: list[dict], domains: list[dict],
                           daily_available_hours: float) -> str:
    """Build a comprehensive statistical summary of the entire plan.

    Returns a human-readable Chinese text block covering domain distribution,
    task-type breakdown, daily load, consecutive-domain issues, and phase
    conformance — so the AI sees the whole structure without receiving every
    raw row.
    """
    from collections import Counter, defaultdict

    total_days = len(schedule)
    if total_days == 0:
        return '（计划为空）'

    daily_budget_min = daily_available_hours * 60

    # ── 1. Domain frequency ─────────────────────────────────────────────
    domain_day_count: dict[str, int] = defaultdict(int)
    for day in schedule:
        seen_in_day: set[str] = set()
        for t in day.get('tasks', []):
            tag = t.get('knowledge_tag', '')
            if tag and tag not in seen_in_day:
                domain_day_count[tag] += 1
                seen_in_day.add(tag)

    domain_lines: list[str] = []
    domain_weight_map = {d.get('name', ''): d.get('weight_pct', 0) for d in domains}
    for tag, days in sorted(domain_day_count.items(), key=lambda x: -x[1]):
        w = domain_weight_map.get(tag, 0)
        flag = ''
        if w > 0:
            expected_days = max(1, round(total_days * w / 100))
            if days < expected_days * 0.6:
                flag = f' ⚠️ 偏少（权重{w}%，应有约{expected_days}天）'
            elif days > expected_days * 1.5:
                flag = f' ⚠️ 偏多（权重{w}%，应有约{expected_days}天）'
        domain_lines.append(f'  {tag}: {days}天{flag}')

    # Domains that never appear
    all_domain_names = {d.get('name', '') for d in domains if d.get('name')}
    missing = all_domain_names - set(domain_day_count.keys())
    missing_line = ''
    if missing:
        missing_line = f'\n  未覆盖的知识域：{", ".join(sorted(missing))}'

    # ── 2. Task-type distribution ───────────────────────────────────────
    type_counter: dict[str, int] = Counter()
    type_labels = {
        'reading': '阅读', 'video': '视频', 'practice': '练习',
        'review': '复习/案例', 'essay': '论文', 'mock_exam': '模考', 'custom': '自定义',
    }
    for day in schedule:
        for t in day.get('tasks', []):
            type_counter[t.get('task_type', 'practice')] += 1

    type_lines = []
    for tt, label in type_labels.items():
        c = type_counter.get(tt, 0)
        if c > 0:
            type_lines.append(f'  {label}({tt}): {c}个任务')
        elif tt in ('essay', 'review', 'mock_exam'):
            type_lines.append(f'  {label}({tt}): 0个任务 ⚠️ 建议补充')

    # ── 3. Daily load ───────────────────────────────────────────────────
    daily_loads: list[int] = []
    empty_days: list[str] = []
    overload_days: list[str] = []
    for day in schedule:
        total = sum(t.get('estimated_min', 0) or 0 for t in day.get('tasks', []))
        daily_loads.append(total)
        date = day.get('date', '?')
        if total == 0:
            empty_days.append(date)
        elif total > daily_budget_min * 1.1:
            overload_days.append(f'{date}({total}分钟/{daily_budget_min:.0f}分钟上限)')

    load_min = min(daily_loads) if daily_loads else 0
    load_max = max(daily_loads) if daily_loads else 0
    load_avg = sum(daily_loads) / len(daily_loads) if daily_loads else 0

    load_lines = [
        f'  最少: {load_min}分钟/天  最多: {load_max}分钟/天  平均: {load_avg:.0f}分钟/天',
        f'  每日上限: {daily_budget_min:.0f}分钟',
    ]
    if empty_days:
        load_lines.append(f'  空白天数({len(empty_days)}): {", ".join(empty_days[:5])}{"…" if len(empty_days) > 5 else ""}')
    if overload_days:
        load_lines.append(f'  超载天数({len(overload_days)}): {", ".join(overload_days[:5])}{"…" if len(overload_days) > 5 else ""}')

    # ── 4. Consecutive same-domain streaks ──────────────────────────────
    streaks: list[str] = []
    for tag in domain_day_count:
        max_streak = 0
        current = 0
        streak_ranges: list[tuple[int, int]] = []
        start_idx: int | None = None
        for i, day in enumerate(schedule):
            tags_today = {t.get('knowledge_tag', '') for t in day.get('tasks', [])}
            if tag in tags_today:
                if current == 0:
                    start_idx = i
                current += 1
            else:
                if current > max_streak:
                    max_streak = current
                if current >= 3 and start_idx is not None:
                    streak_ranges.append((start_idx, i - 1))
                current = 0
                start_idx = None
        if current > max_streak:
            max_streak = current
        if current >= 3 and start_idx is not None:
            streak_ranges.append((start_idx, len(schedule) - 1))

        if max_streak >= 3:
            range_strs = [
                f'{schedule[s].get("date","?")}~{schedule[e].get("date","?")}'
                for s, e in streak_ranges
            ]
            streaks.append(f'  {tag}: 最长连续{max_streak}天 ({"; ".join(range_strs)}) ⚠️')

    # ── 5. Phase conformance ────────────────────────────────────────────
    foundation_days = round(total_days * 0.6)
    reinforcement_days = round(total_days * 0.3)
    sprint_days = total_days - foundation_days - reinforcement_days

    def _phase_type_dist(slice_start: int, slice_end: int) -> dict[str, int]:
        c: dict[str, int] = Counter()
        for day in schedule[slice_start:slice_end]:
            for t in day.get('tasks', []):
                c[t.get('task_type', 'practice')] += 1
        return dict(c)

    fd = _phase_type_dist(0, foundation_days)
    rd = _phase_type_dist(foundation_days, foundation_days + reinforcement_days)
    sd = _phase_type_dist(foundation_days + reinforcement_days, total_days)

    def _pct(d: dict[str, int], key: str) -> int:
        total = sum(d.values()) or 1
        return round(d.get(key, 0) / total * 100)

    phase_lines = [
        f'  基础阶段(前{foundation_days}天): 阅读{_pct(fd,"reading")}% 练习{_pct(fd,"practice")}% '
        f'复习{_pct(fd,"review")}% 论文{_pct(fd,"essay")}% 模考{_pct(fd,"mock_exam")}% '
        + ('⚠️ 论文/模考不应在基础阶段出现' if _pct(fd, 'essay') > 5 or _pct(fd, 'mock_exam') > 5 else '✓'),

        f'  强化阶段(中{reinforcement_days}天): 阅读{_pct(rd,"reading")}% 练习{_pct(rd,"practice")}% '
        f'复习{_pct(rd,"review")}% 论文{_pct(rd,"essay")}% 模考{_pct(rd,"mock_exam")}% '
        + ('⚠️ 论文/案例分析偏少' if _pct(rd, 'essay') < 5 and _pct(rd, 'review') < 10 else '✓'),

        f'  冲刺阶段(后{sprint_days}天): 阅读{_pct(sd,"reading")}% 练习{_pct(sd,"practice")}% '
        f'复习{_pct(sd,"review")}% 论文{_pct(sd,"essay")}% 模考{_pct(sd,"mock_exam")}% '
        + ('⚠️ 模考/复习占比应最高' if _pct(sd, 'mock_exam') + _pct(sd, 'review') < 40 else '✓'),
    ]

    # ── Assemble ─────────────────────────────────────────────────────────
    parts = [
        '【知识域覆盖】（天数/权重对比）',
        *domain_lines,
        *([missing_line] if missing_line else []),
        '',
        '【任务类型分布】（全计划汇总）',
        *type_lines,
        '',
        '【每日负载统计】',
        *load_lines,
        '',
        '【同域连续问题】（连续≥3天需拆分）',
        *(streaks if streaks else ['  （无异常）']),
        '',
        '【阶段吻合度】（各阶段 task_type %）',
        *phase_lines,
    ]
    return '\n'.join(parts)


def _strategic_samples(schedule: list[dict], n: int = 8) -> str:
    """Sample representative days evenly across the entire plan.

    Strategy: day 1, phase-transition neighbours, evenly-spaced fill,
    plus any anomalous days (empty / overload).  Returns a formatted
    text block suitable for the AI prompt.
    """
    total_days = len(schedule)
    if total_days == 0:
        return '（无数据）'

    indices: set[int] = set()

    # Always include first and last
    indices.add(0)
    if total_days > 1:
        indices.add(total_days - 1)

    # Phase transition neighbours
    foundation_end = round(total_days * 0.6)
    reinforcement_end = round(total_days * 0.9)
    for pivot in (foundation_end, reinforcement_end):
        for offset in (-1, 0, 1):
            idx = pivot + offset
            if 0 <= idx < total_days:
                indices.add(idx)

    # Evenly spaced fill
    if n > 2:
        step = max(1, total_days // (n - len(indices) + 1))
        for i in range(0, total_days, step):
            if len(indices) >= n + 4:
                break
            indices.add(i)

    # Anomalous days (empty days — AI should see these)
    for i, day in enumerate(schedule):
        total = sum(t.get('estimated_min', 0) or 0 for t in day.get('tasks', []))
        if total == 0:
            indices.add(i)

    # Build output sorted by index
    lines: list[str] = []
    for i in sorted(indices):
        day = schedule[i]
        date = day.get('date', '?')
        tasks = day.get('tasks', [])
        total_min = sum(t.get('estimated_min', 0) or 0 for t in tasks)
        task_list = '; '.join(
            f"[{t.get('task_type','?')}] {t.get('knowledge_tag','?')}({t.get('estimated_min',0) or 0}分)"
            for t in tasks
        )
        phase_label = ''
        if i < foundation_end:
            phase_label = ' [基础]'
        elif i < reinforcement_end:
            phase_label = ' [强化]'
        else:
            phase_label = ' [冲刺]'
        lines.append(f'  第{i+1}天 {date}{phase_label} (计{total_min}分): {task_list}')

    return '\n'.join(lines)


def _full_repetition_analysis(schedule: list[dict]) -> str:
    """Detect duplicate day-patterns across the ENTIRE plan.

    Returns a formatted Chinese text block listing repeated patterns
    with their occurrence dates, or a note that none were found.
    """
    total_days = len(schedule)
    if total_days == 0:
        return '（计划为空）'

    pattern_map: dict[str, list[str]] = {}
    for day in schedule:
        sig = _day_fingerprint(day)
        date = day.get('date', '?')
        pattern_map.setdefault(sig, []).append(date)

    # Keep patterns that appear 2+ times, sorted by frequency desc
    dupes = [(sig, dates) for sig, dates in pattern_map.items() if len(dates) >= 2]
    dupes.sort(key=lambda x: -len(x[1]))

    if not dupes:
        return '（全量检测：无重复模式 ✓）'

    lines: list[str] = [f'共检测到 {len(dupes)} 组重复模式，涉及 '
                         f'{sum(len(d) for _, d in dupes)} 天：']
    for sig, dates in dupes[:10]:
        tasks_preview = sig[:120]
        lines.append(f'  模式 [{tasks_preview}…] 出现{len(dates)}次: {", ".join(dates[:8])}'
                     + ('…' if len(dates) > 8 else ''))

    duplicate_day_count = sum(len(d) - 1 for _, d in dupes)
    lines.append(f'  总计 {duplicate_day_count} 天为重复日（可替换为新内容或缓冲日）')

    return '\n'.join(lines)


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


# ─── Phase 2: Question auto-tagging (FTS + tag aggregation) ───────────────────

class AutoTagQuestion(BaseModel):
    id: str = ""
    type: str = "single"
    content: str
    options: list[str] = []
    answer: str = ""
    explanation: str = ""
    content_hash: str = ""


class SearchResultChunk(BaseModel):
    id: str = ""
    page_num: int = 0
    content: str = ""
    knowledge_tags: list  # list[str] or list[{t, c}]
    chunk_type: str = "text"
    confidence: float | None = None
    doc_title: str = ""
    score: float = 0.0


class AutoTagRequest(BaseModel):
    questions: list[AutoTagQuestion]
    search_results: list[list[SearchResultChunk]]  # 每个题目对应一个 chunk 列表
    domain_map: dict[str, dict] = {}  # name → {id, parent_id, name, level}
    ai_config: dict = {}              # AI 配置，用于 Layer 2 兜底
    domain_tree_text: str = ""        # 知识领域树文本，用于 AI prompt
    domain_names: list[str] = []      # 所有合法标签名，用于校验 AI 输出


class AutoTagResponse(BaseModel):
    results: list[dict]
    summary: dict
    search_results: list[list[dict]] = []  # 透传前端需要的检索结果


@router.post('/auto-tag-questions', response_model=AutoTagResponse)
async def auto_tag_questions(req: AutoTagRequest):
    """批量自动标注题目知识点 (FTS + AI + 关键词兜底)。

    接收题目列表和对应的 FTS 检索结果，执行标签聚合 + 层次去重，
    对低置信度题目自动调用 AI 分类，AI 失败后再使用关键词兜底。
    """
    domain_map = req.domain_map or {}
    valid_names = set(req.domain_names) if req.domain_names else set()
    provider = None
    if req.ai_config.get("mode"):
        try:
            provider = build_provider(req.ai_config)
        except Exception as e:
            logger.warning("Failed to build AI provider for auto-tag: {}", e)

    results = []
    total_chunks = 0
    chunks_with_tags = 0

    from modules.ai.question_classifier import classify_question_with_fallback

    async def process_one(i: int, question: AutoTagQuestion):
        chunks_raw = req.search_results[i] if i < len(req.search_results) else []
        chunks = [c.model_dump() for c in chunks_raw]

        result = await classify_question_with_fallback(
            question.model_dump(),
            chunks,
            domain_map if domain_map else None,
            provider,
            req.domain_tree_text,
            valid_names,
        )
        result["question_id"] = question.id
        result["content_hash"] = question.content_hash
        return result, len(chunks), sum(
            1 for c in chunks if c.get("knowledge_tags") and len(c.get("knowledge_tags", [])) > 0
        )

    # 并发处理，限制最大并发数避免压垮 AI 服务
    semaphore = asyncio.Semaphore(5)

    async def bounded_process_one(i: int, question: AutoTagQuestion):
        async with semaphore:
            return await process_one(i, question)

    tasks = [bounded_process_one(i, q) for i, q in enumerate(req.questions)]
    processed = await asyncio.gather(*tasks)

    for result, chunk_count, tagged_count in processed:
        results.append(result)
        total_chunks += chunk_count
        chunks_with_tags += tagged_count

    # 汇总
    auto_tagged = sum(1 for r in results if r.get("knowledge_tags"))
    ai_tagged = sum(1 for r in results if r.get("source") == "ai_classifier")
    keyword_tagged = sum(1 for r in results if r.get("source") == "keyword_fallback")
    fts_tagged = sum(1 for r in results if r.get("source") == "fts_document" and r.get("knowledge_tags"))
    none_tagged = sum(1 for r in results if not r.get("knowledge_tags"))

    logger.info(
        "Auto-tag summary: {} questions, {} total chunks ({} with tags), "
        "auto_tagged={}, ai_tagged={}, keyword_tagged={}, fts_tagged={}, none_tagged={}",
        len(results), total_chunks, chunks_with_tags,
        auto_tagged, ai_tagged, keyword_tagged, fts_tagged, none_tagged,
    )
    logger.debug("Auto-tag sample results: {}", results[:3])

    return AutoTagResponse(
        results=results,
        summary={
            "total": len(results),
            "auto_tagged": auto_tagged,
            "ai_tagged": ai_tagged,
            "keyword_tagged": keyword_tagged,
            "fts_tagged": fts_tagged,
            "needs_ai": 0,  # fallback 已完成
            "none_tagged": none_tagged,
        },
        search_results=[[c.model_dump() for c in chunks] for chunks in req.search_results],
    )


# ─── Phase 3: Layer 2 AI question classification fallback ────────────────────


class ClassifyQuestionTagsRequest(BaseModel):
    ai_config: dict
    questions: list[dict]         # [{id, type, content, options, answer, explanation}]
    layer1_results: list[dict]    # Layer 1 结果 [{question_id, knowledge_tags, confidence, needs_ai}]
    layer1_chunks: list[list[dict]]  # 每题的 Top-K chunk
    domain_tree_text: str = ""
    domain_names: list[str] = []   # 所有合法标签名（用于校验）


@router.post('/classify-question-tags')
async def classify_question_tags(req: ClassifyQuestionTagsRequest):
    """Layer 2: AI fallback 分类。对 Layer 1 低置信度题目使用 LLM 重新分类。

    接收题目 + Layer 1 结果 + 检索到的文档块，用 LLM + 知识树进行分类。
    返回校验过的标签（仅保留知识树中存在的标签）。
    """
    from modules.ai.question_classifier import (
        classify_question_tags_ai,
        classify_question_tags_keyword,
    )

    provider = build_provider(req.ai_config)
    domain_tree = req.domain_tree_text or "（使用通用软考系统架构设计师知识体系）"
    valid_names = set(req.domain_names) if req.domain_names else set()
    logger.info("classify-question-tags: {} questions, domain_names={}, provider={}",
                len(req.questions), len(valid_names), type(provider).__name__)
    results = []

    for i, question in enumerate(req.questions):
        qid = question.get("id", str(i))
        l1 = req.layer1_results[i] if i < len(req.layer1_results) else {}
        chunks = req.layer1_chunks[i] if i < len(req.layer1_chunks) else []

        # 仅处理需要 AI 的题目
        if not l1.get("needs_ai", False) and l1.get("knowledge_tags"):
            results.append({
                "question_id": qid,
                "knowledge_tags": l1.get("knowledge_tags", []),
                "confidence": l1.get("confidence", []),
                "source": "fts_document",
                "reasoning": "",
                "ai_used": False,
            })
            continue

        try:
            ai_result = await classify_question_tags_ai(
                provider, question, domain_tree, valid_names, chunks
            )
            if ai_result.get("knowledge_tags"):
                results.append({
                    "question_id": qid,
                    "knowledge_tags": ai_result["knowledge_tags"],
                    "confidence": ai_result["confidence"],
                    "source": "ai_classifier",
                    "reasoning": ai_result.get("reasoning", ""),
                    "ai_used": True,
                    "validated": ai_result.get("validated", True),
                })
                continue
        except Exception as e:
            logger.warning("AI classify question {} failed: {}", qid, e)

        # 关键词兜底
        kw_result = classify_question_tags_keyword(question, list(valid_names))
        if kw_result.get("knowledge_tags"):
            results.append({
                "question_id": qid,
                "knowledge_tags": kw_result["knowledge_tags"],
                "confidence": kw_result["confidence"],
                "source": "keyword_fallback",
                "reasoning": "",
                "ai_used": False,
            })
            continue

        # 全部失败，保留 Layer 1 结果或空
        results.append({
            "question_id": qid,
            "knowledge_tags": l1.get("knowledge_tags", []),
            "confidence": l1.get("confidence", []),
            "source": "fts_document",
            "reasoning": "AI 与关键词兜底均未命中",
            "ai_used": False,
        })

    return {
        "results": results,
        "ai_classified": sum(1 for r in results if r.get("ai_used")),
    }


# ─── Phase 0: AI Chunk Reclassification ───────────────────────────────────────

RECLASSIFY_SYSTEM_PROMPT = """你是《系统架构设计师》考试教材的内容分类专家。
请判断以下教材段落属于哪个（或哪些）知识点。

## 知识领域体系（必须从以下列表中选择，不得编造）

{{domain_tree}}

## 教材段落上下文
{{context_chunks}}

## 待分类段落
{{target_chunk}}

## 要求
1. 从上述知识体系中选择 1-3 个最相关的知识点
2. 优先选择三级知识点（最具体）；如果不确定三级，可选二级或一级
3. 如果段落是纯介绍性/概述性内容，可选择对应章节的一级标签
4. 如果段落确实不属于任何知识点（如前言/目录/致谢），返回空数组
5. 为每个标签给出置信度（0-1）

返回 JSON：
{
  "knowledge_tags": ["三级知识点完整名称"],
  "confidence": [0.95],
  "reasoning": "该段落在讨论...，属于...知识领域"
}"""


class ReclassifyChunkRequest(BaseModel):
    ai_config: dict
    chunk_content: str                     # 待分类段落原文
    neighbor_contents: list[str] = []      # 前后各 2 个 chunk 的内容
    domain_tree_text: str = ""             # 知识领域树文本（已格式化）


@router.post('/reclassify-chunk')
async def reclassify_chunk(req: ReclassifyChunkRequest):
    """AI 重分类单个低置信度 chunk。"""
    provider = build_provider(req.ai_config)

    context_text = ""
    if req.neighbor_contents:
        parts = [f"【上下文段落 {i + 1}】\n{nc[:600]}" for i, nc in enumerate(req.neighbor_contents[:4])]
        context_text = "\n\n".join(parts)

    system_prompt = RECLASSIFY_SYSTEM_PROMPT.replace(
        "{{domain_tree}}", req.domain_tree_text or "（使用通用软考系统架构设计师知识体系）"
    ).replace(
        "{{context_chunks}}", context_text or "（无额外上下文）"
    ).replace(
        "{{target_chunk}}", req.chunk_content[:1500]
    )

    try:
        raw = await provider.chat([
            {'role': 'system', 'content': system_prompt},
            {'role': 'user', 'content': f'请分类以下教材段落：\n\n{req.chunk_content[:1500]}'},
        ], temperature=0.3)
        result = extract_json(raw)
        return {
            "knowledge_tags": result.get("knowledge_tags", []),
            "confidence": result.get("confidence", []),
            "reasoning": result.get("reasoning", ""),
        }
    except Exception as e:
        logger.warning("Chunk reclassification failed: {}", e)
        raise HTTPException(status_code=_status_code_for_ai_error(e),
                           detail=f'AI 重分类失败: {e}')


class ReclassifyChunkBatchRequest(BaseModel):
    ai_config: dict
    chunks: list[dict]                    # [{id, content, neighbor_contents[]}]
    domain_tree_text: str = ""


@router.post('/reclassify-chunk-batch')
async def reclassify_chunk_batch(req: ReclassifyChunkBatchRequest):
    """批量 AI 重分类低置信度 chunk（串行处理）。"""
    provider = build_provider(req.ai_config)
    domain_tree = req.domain_tree_text or "（使用通用软考系统架构设计师知识体系）"
    results = []

    for chunk in req.chunks:
        content = chunk.get("content", "")[:1500]
        neighbor_contents = chunk.get("neighbor_contents", [])[:4]

        context_text = ""
        if neighbor_contents:
            parts = [f"【上下文段落 {j + 1}】\n{nc[:600]}" for j, nc in enumerate(neighbor_contents)]
            context_text = "\n\n".join(parts)

        system_prompt = RECLASSIFY_SYSTEM_PROMPT.replace(
            "{{domain_tree}}", domain_tree
        ).replace(
            "{{context_chunks}}", context_text or "（无额外上下文）"
        ).replace(
            "{{target_chunk}}", content
        )

        try:
            raw = await provider.chat([
                {'role': 'system', 'content': system_prompt},
                {'role': 'user', 'content': f'请分类以下教材段落：\n\n{content}'},
            ], temperature=0.3)
            result = extract_json(raw)
            results.append({
                "chunk_id": chunk.get("id"),
                "knowledge_tags": result.get("knowledge_tags", []),
                "confidence": result.get("confidence", []),
                "reasoning": result.get("reasoning", ""),
                "error": None,
            })
        except Exception as e:
            logger.warning("Batch reclassification chunk {} failed: {}", chunk.get('id'), e)
            results.append({
                "chunk_id": chunk.get("id"),
                "knowledge_tags": [],
                "confidence": [],
                "reasoning": "",
                "error": str(e),
            })

    return {"results": results, "total": len(req.chunks), "success": sum(1 for r in results if not r.get("error"))}
