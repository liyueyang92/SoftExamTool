"""
Deterministic schedule builder for study plans.

Problem: LLMs cannot reliably output a full N-day JSON schedule — output
token limits cause truncation at ~15 days, and the day-by-day JSON is
wasteful for what is essentially a structured rotation problem.

Solution: AI outputs only high-level *parameters* (~200 tokens, tiny JSON).
The rule engine here expands them into the full daily_schedule, guaranteeing
100% coverage of all N days with zero truncation.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from datetime import date, timedelta

# ── Constants ───────────────────────────────────────────────────────────────

PHASE_ORDER = ["foundation", "reinforcement", "sprint"]

ALL_TASK_TYPES = ["reading", "video", "practice", "review", "essay", "mock_exam", "custom"]

# ── Parameter model ─────────────────────────────────────────────────────────


@dataclass
class ScheduleParams:
    """High-level parameters controlling schedule generation.

    Serializes cleanly to/from JSON.  This is what the AI outputs (tiny!)
    and what the builder expands into the full daily_schedule.
    """

    plan_name: str = "备考计划"

    # ── Core ──
    domains: list[dict] = field(default_factory=list)  # [{name, weight_pct}]
    total_days: int = 60
    daily_minutes: int = 120
    start_date: str = ""  # ISO date, empty = today

    # ── Phase split (3 floats summing to 1.0) ──
    phase_ratios: list[float] = field(default_factory=lambda: [0.60, 0.25, 0.15])

    # ── Buffer / rest days ──
    buffer_interval: int = 7  # every N days, 0 = disabled
    buffer_on: bool = True

    # ── Task-type mix per phase (percentages, 0-100) ──
    task_type_mix: dict = field(default_factory=lambda: {
        "foundation":    {"reading": 50, "practice": 40, "review": 10},
        "reinforcement": {"practice": 40, "review": 30, "essay": 15, "reading": 15},
        "sprint":        {"mock_exam": 40, "review": 30, "practice": 20, "essay": 10},
    })

    # ── Domain rotation ──
    domain_priorities: list[str] = field(default_factory=list)   # weak tags
    domain_boost_ratio: float = 1.5   # priority domains appear 1.5× more
    max_consecutive_domain: int = 2

    # ── Special task intervals (phase 2+) ──
    essay_interval: int = 5       # N days between essay tasks
    case_study_interval: int = 4  # N days between case-study (review) tasks

    # ── Task density ──
    tasks_per_day_min: int = 1
    tasks_per_day_max: int = 3

    def to_dict(self) -> dict:
        """Serialise to a JSON-friendly dict (for IPC / storage)."""
        return {
            "plan_name": self.plan_name,
            "total_days": self.total_days,
            "daily_minutes": self.daily_minutes,
            "start_date": self.start_date,
            "phase_ratios": self.phase_ratios,
            "buffer_interval": self.buffer_interval,
            "buffer_on": self.buffer_on,
            "task_type_mix": self.task_type_mix,
            "domain_priorities": self.domain_priorities,
            "domain_boost_ratio": self.domain_boost_ratio,
            "max_consecutive_domain": self.max_consecutive_domain,
            "essay_interval": self.essay_interval,
            "case_study_interval": self.case_study_interval,
            "tasks_per_day_min": self.tasks_per_day_min,
            "tasks_per_day_max": self.tasks_per_day_max,
            "domains": self.domains,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "ScheduleParams":
        """Deserialise from a JSON-friendly dict."""
        defaults = {
            "plan_name", "total_days", "daily_minutes", "start_date",
            "phase_ratios", "buffer_interval", "buffer_on", "task_type_mix",
            "domain_priorities", "domain_boost_ratio", "max_consecutive_domain",
            "essay_interval", "case_study_interval", "tasks_per_day_min",
            "tasks_per_day_max", "domains",
        }
        kwargs = {k: v for k, v in d.items() if k in defaults}
        # Rename domain_priorities from AI output if needed
        if "domain_priorities" in kwargs and isinstance(kwargs["domain_priorities"], list):
            pass  # already correct
        return cls(**kwargs)

    @classmethod
    def default_normal(cls, domains: list[dict], total_days: int,
                       daily_minutes: int, start_date: str = "") -> "ScheduleParams":
        """Factory: sensible defaults for 'normal' (full-prep) mode."""
        return cls(
            domains=domains,
            total_days=total_days,
            daily_minutes=daily_minutes,
            start_date=start_date,
            phase_ratios=[0.60, 0.25, 0.15],
            buffer_on=True,
            buffer_interval=7,
        )

    @classmethod
    def default_sprint(cls, domains: list[dict], total_days: int,
                       daily_minutes: int, start_date: str = "") -> "ScheduleParams":
        """Factory: sensible defaults for 'sprint' mode."""
        return cls(
            domains=domains,
            total_days=total_days,
            daily_minutes=daily_minutes,
            start_date=start_date,
            phase_ratios=[0.20, 0.40, 0.40],
            buffer_on=False,
            buffer_interval=0,
            task_type_mix={
                "foundation":    {"reading": 30, "practice": 50, "review": 20},
                "reinforcement": {"practice": 30, "review": 30, "essay": 20, "mock_exam": 20},
                "sprint":        {"mock_exam": 50, "review": 30, "practice": 20},
            },
        )


# ── Internal helpers ────────────────────────────────────────────────────────


def _domain_names(params: ScheduleParams) -> list[str]:
    return [d.get("name", "") for d in params.domains if d.get("name")]


def _domain_weight_map(params: ScheduleParams) -> dict[str, float]:
    """Build {name: adjusted_weight}, boosting priority domains."""
    wmap: dict[str, float] = {}
    for d in params.domains:
        name = d.get("name", "")
        w = d.get("weight_pct", 0)
        if name:
            wmap[name] = max(w, 1)  # floor 1% so every domain appears
    for name in params.domain_priorities:
        if name in wmap:
            wmap[name] *= params.domain_boost_ratio
    return wmap


def _weighted_round_robin(
    domains: list[str],
    weights: dict[str, float],
    count: int,
    max_consecutive: int,
    rng: random.Random,
) -> list[str]:
    """Generate `count` domain assignments via weighted round-robin.

    Guarantees no domain repeats more than `max_consecutive` times.
    """
    if not domains:
        return [""] * count

    result: list[str] = []
    recent: list[str] = []  # sliding window of size max_consecutive

    for _ in range(count):
        # Domains not yet at their consecutive limit
        candidates = [d for d in domains if recent.count(d) < max_consecutive]
        if not candidates:
            candidates = list(domains)

        # Weighted random pick
        cw = [weights.get(d, 1) for d in candidates]
        total = sum(cw)
        r = rng.uniform(0, total)
        cumulative = 0.0
        chosen = candidates[-1]
        for d, w in zip(candidates, cw):
            cumulative += w
            if r <= cumulative:
                chosen = d
                break

        result.append(chosen)
        recent.append(chosen)
        if len(recent) > max_consecutive:
            recent.pop(0)

    return result


def _pick_task_types(
    phase: str,
    task_type_mix: dict,
    count: int,
    rng: random.Random,
) -> list[str]:
    """Pick `count` task types weighted by phase distribution, no repeats."""
    mix = task_type_mix.get(phase, task_type_mix.get("foundation", {}))
    if not mix:
        return ["practice"] * count

    available = [(t, w) for t, w in mix.items() if w > 0]
    if not available:
        return ["practice"] * count

    result: list[str] = []
    for _ in range(min(count, len(available))):
        t_list, w_list = zip(*available)
        total = sum(w_list)
        r = rng.uniform(0, total)
        cumulative = 0.0
        chosen = t_list[-1]
        chosen_idx = len(available) - 1
        for idx, (t, w) in enumerate(available):
            cumulative += w
            if r <= cumulative:
                chosen = t
                chosen_idx = idx
                break
        result.append(chosen)
        available.pop(chosen_idx)

    return result


def _estimate_min(task_type: str, daily_minutes: int, task_count: int) -> int:
    """Allocate minutes to a task, rounding to the nearest 5."""
    base = max(15, daily_minutes // max(task_count, 1))
    multipliers = {
        "reading": 1.2, "video": 0.8, "practice": 1.0,
        "review": 1.1, "essay": 1.5, "mock_exam": 1.5, "custom": 0.5,
    }
    return max(10, round(base * multipliers.get(task_type, 1.0) / 5) * 5)


def _suggested_count(task_type: str) -> int:
    return {
        "reading": 0, "video": 0, "practice": 15,
        "review": 10, "essay": 0, "mock_exam": 20, "custom": 0,
    }.get(task_type, 0)


def _task_priority(task_type: str, phase: str, domain: str,
                   priority_domains: list[str]) -> int:
    if task_type == "mock_exam":
        return 3
    if phase == "sprint":
        return 2
    if domain in priority_domains:
        return 2
    if task_type == "essay":
        return 2
    if task_type == "review" and phase == "reinforcement":
        return 1
    return 0


# ── Main builder ────────────────────────────────────────────────────────────


def build_schedule(params: ScheduleParams, seed: int = 42) -> list[dict]:
    """Expand ScheduleParams into a complete daily_schedule.

    Deterministic given the same params + seed.  Returns a list of day
    dicts, one per day from start_date for total_days.
    """
    rng = random.Random(seed)
    domains = _domain_names(params)
    weights = _domain_weight_map(params)

    if not domains:
        return []

    start = date.today() if not params.start_date else date.fromisoformat(params.start_date)

    # ── Phase boundaries ─────────────────────────────────────────────────
    rf, rr, rs = params.phase_ratios
    n_foundation   = max(1, round(params.total_days * rf))
    n_reinforcement = max(1, round(params.total_days * rr))
    n_sprint       = max(0, params.total_days - n_foundation - n_reinforcement)

    reinf_start  = n_foundation
    sprint_start = n_foundation + n_reinforcement

    # ── Buffer days ──────────────────────────────────────────────────────
    buffer_days: set[int] = set()
    if params.buffer_on and params.buffer_interval > 0:
        for i in range(params.buffer_interval - 1, params.total_days, params.buffer_interval):
            buffer_days.add(i)

    # ── Assign domains (non-buffer days only) ────────────────────────────
    active_indices = [i for i in range(params.total_days) if i not in buffer_days]
    domain_seq = _weighted_round_robin(
        domains, weights, len(active_indices), params.max_consecutive_domain, rng,
    )
    day_domain: dict[int, str] = {}
    for idx, day_i in enumerate(active_indices):
        day_domain[day_i] = domain_seq[idx]
    for bi in buffer_days:
        day_domain[bi] = ""

    # ── Essay / case-study insertion points ───────────────────────────────
    essay_days: set[int] = set()
    case_days: set[int] = set()
    if params.essay_interval > 0:
        for i in range(reinf_start, params.total_days, params.essay_interval):
            if i not in buffer_days:
                essay_days.add(i)
    if params.case_study_interval > 0:
        for i in range(reinf_start, params.total_days, params.case_study_interval):
            if i not in buffer_days and i not in essay_days:
                case_days.add(i)

    # ── Produce schedule ─────────────────────────────────────────────────
    schedule: list[dict] = []

    for i in range(params.total_days):
        d = (start + timedelta(days=i)).isoformat()
        phase = (
            "foundation" if i < n_foundation else
            "reinforcement" if i < sprint_start else
            "sprint"
        )
        domain = day_domain.get(i, "")
        is_buffer = i in buffer_days

        # Task count
        n_tasks = (params.tasks_per_day_min if is_buffer
                   else rng.randint(params.tasks_per_day_min, params.tasks_per_day_max))

        # Task types
        if is_buffer:
            task_types = ["review"]
        else:
            task_types = _pick_task_types(phase, params.task_type_mix, n_tasks, rng)

        # Override for special days
        if i in essay_days and "essay" not in task_types:
            task_types = ["essay"] + task_types[:params.tasks_per_day_max - 1]
        if i in case_days and "review" not in task_types:
            task_types = ["review"] + task_types[:params.tasks_per_day_max - 1]

        task_types = task_types[:params.tasks_per_day_max]

        # Build task dicts
        tasks = []
        for tt in task_types:
            est = _estimate_min(tt, params.daily_minutes, len(task_types))
            tasks.append({
                "knowledge_tag": domain,
                "task_type": tt,
                "estimated_min": est,
                "suggested_count": _suggested_count(tt),
                "priority": _task_priority(tt, phase, domain, params.domain_priorities),
            })

        schedule.append({"date": d, "phase": phase, "tasks": tasks})

    return schedule


# ── AI parameter helpers ────────────────────────────────────────────────────


def params_from_ai_response(ai_json: dict, base: ScheduleParams) -> ScheduleParams:
    """Merge AI-returned parameter overrides into a base ScheduleParams.

    The AI outputs a tiny JSON with only the fields it wants to change.
    This function applies those overrides on top of sensible defaults.
    """
    # Numeric / simple fields
    for key in ("plan_name", "total_days", "daily_minutes", "start_date",
                "buffer_interval", "domain_boost_ratio", "max_consecutive_domain",
                "essay_interval", "case_study_interval",
                "tasks_per_day_min", "tasks_per_day_max"):
        if key in ai_json:
            setattr(base, key, ai_json[key])

    for key in ("buffer_on",):
        if key in ai_json:
            setattr(base, key, bool(ai_json[key]))

    # Phase ratios
    if "phase_ratios" in ai_json and isinstance(ai_json["phase_ratios"], list):
        pr = ai_json["phase_ratios"]
        if len(pr) == 3 and abs(sum(pr) - 1.0) < 0.05:
            base.phase_ratios = pr

    # Task type mix
    if "task_type_mix" in ai_json and isinstance(ai_json["task_type_mix"], dict):
        for phase in PHASE_ORDER:
            if phase in ai_json["task_type_mix"]:
                base.task_type_mix[phase] = ai_json["task_type_mix"][phase]

    # Domain priorities
    if "domain_priorities" in ai_json and isinstance(ai_json["domain_priorities"], list):
        base.domain_priorities = [str(t) for t in ai_json["domain_priorities"]]

    return base
