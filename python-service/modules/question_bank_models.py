from typing import Literal

from pydantic import BaseModel, Field, model_validator

QuestionGroupType = Literal['custom', 'past_exam', 'ai_generated', 'crawled', 'manual_import']
ExamPeriod = Literal['H1', 'H2']
QuestionSourceType = Literal['manual', 'ai_generated', 'crawled', 'imported']
QuestionType = Literal['single', 'multiple', 'case', 'essay']


class NewQuestionGroupModel(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    group_type: QuestionGroupType = 'custom'
    exam_year: int | None = None
    exam_period: ExamPeriod | None = None
    description: str = ''

    @model_validator(mode='after')
    def validate_past_exam_metadata(self):
        if self.group_type == 'past_exam':
            if self.exam_year is None or self.exam_period is None:
                raise ValueError('past_exam 分组必须提供 exam_year 和 exam_period')
        else:
            self.exam_year = None
            self.exam_period = None
        return self


class QuestionGroupModel(NewQuestionGroupModel):
    id: str
    created_at: str | None = None
    updated_at: str | None = None


class QuestionPayloadModel(BaseModel):
    group_id: str | None = None
    type: QuestionType
    content: str = Field(min_length=1)
    options: list[str] | None = None
    answer: str | None = None
    explanation: str | None = None
    knowledge_tags: list[str] = Field(default_factory=list)
    difficulty: int = Field(default=3, ge=1, le=5)
    source_type: QuestionSourceType = 'manual'
    source_url: str | None = None
