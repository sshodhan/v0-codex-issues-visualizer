"""Pydantic response models."""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field


Severity = Literal["critical", "high", "medium", "low"]
TimelineStatus = Literal["baseline", "emerging", "crisis", "peak_crisis", "recovery", "recovered"]


class Category(BaseModel):
    id: str
    name: str
    slug: str
    color: str
    share_pct: float


class UserSegment(BaseModel):
    id: str
    name: str
    slug: str
    description: str | None
    developer_count_range: str | None
    crisis_severity_percentage: float
    cost_impact_percentage: float
    recovery_speed_percentage: float


class RootCauseBase(BaseModel):
    id: str
    product: str
    title: str
    description: str | None
    component: str | None
    error_type: str | None
    severity: Severity
    first_detected: date | None
    identified_date: date | None
    fixed_date: date | None
    fixed_in_version: str | None
    estimated_users_impacted_percentage: float


class Issue(BaseModel):
    id: str
    source: str
    source_id: str
    product: str
    title: str
    description: str | None
    url: str | None
    category_id: str | None
    severity: Severity
    sentiment_score: float = Field(ge=-1, le=1)
    engagement_score: float
    mention_count: int
    affected_segments: list[str]
    root_cause_id: str | None
    duplicate_of_id: str | None = None
    created_at: datetime


class IssueListResponse(BaseModel):
    data: list[Issue]
    total: int
    limit: int
    offset: int


class IssueDetail(BaseModel):
    issue: Issue
    category: Category | None
    root_cause: RootCauseBase | None
    related_issues: list[Issue]


class RootCauseWithCount(RootCauseBase):
    affected_issue_count: int


class RootCauseDetail(BaseModel):
    root_cause: RootCauseBase
    affected_issues: list[Issue]


class SegmentImpactAnalysis(BaseModel):
    segment: UserSegment
    affected_issues: list[Issue]
    metrics: dict


class TimelinePoint(BaseModel):
    month: date
    sentiment: float
    issue_freq: int
    status: TimelineStatus
    note: str | None


class TimelineResponse(BaseModel):
    points: list[TimelinePoint]
    peak_crisis: TimelinePoint
    peak_recovery: TimelinePoint


class CategoryStats(BaseModel):
    category: Category
    issue_count: int
    avg_sentiment: float


class CategoryAnalytics(BaseModel):
    by_category: list[CategoryStats]
    total: int


class SentimentBucket(BaseModel):
    bucket: str
    count: int


class SentimentAnalytics(BaseModel):
    distribution: list[SentimentBucket]
    trend: list[TimelinePoint]
    stats: dict


class CompetitiveRow(BaseModel):
    id: str
    product: str
    display_name: str
    code_quality_score: float
    efficiency_score: float
    cost_per_task_usd: float
    context_window_tokens: int
    agent_autonomy_score: float
    market_sentiment: float
    adoption_rate: float
    enterprise_readiness_score: float
    summary: str | None


class HealthResponse(BaseModel):
    status: Literal["ok"]
    version: str
    environment: str
    db: str
    redis: str
    seed_fallback: bool
