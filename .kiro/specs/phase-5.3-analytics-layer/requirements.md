# Requirements Document

## Introduction

This document specifies requirements for adding advanced analytics to AgentHQ. The enhancement adds performance metrics collection, cost analysis, bottleneck detection, and predictive ETA estimation.

Analytics results are cached (5-minute TTL) and exposed via REST endpoints, with a new dashboard page featuring inline SVG charts for visualization.

**Dependencies:** This phase requires:
- Phase 5.1 (Database Layer) for metrics storage and queries
- Phase 5.2 (WebSocket Layer) for real-time metric update notifications

## Glossary

- **AgentHQ**: Developer agent monitoring dashboard built with Bun, TypeScript, and file-based storage
- **Workspace**: Monitored Kiro agent execution environment
- **Job**: Agent execution instance with status, logs, and metrics
- **Bottleneck**: Operation taking significantly longer than average for its type (>2x)
- **Anomaly**: Statistical outlier in performance metrics (>3 standard deviations)
- **Cold_Start**: Insufficient historical data for predictions (< 5 samples)
- **Confidence_Score**: Reliability estimate for ETA prediction (0–1 scale)

## Requirements

### Requirement 1: Performance Metrics Collection

**User Story:** As a developer, I want to track job performance metrics, so that I can identify slow operations and optimize workflows.

#### Acceptance Criteria

1. WHEN a job completes (status becomes "done" OR "error"), THE Metrics_Collector SHALL extract duration, token counts, and cost from the job log
2. THE Job_Metrics_Table SHALL store duration_ms, input_tokens, output_tokens, total_tokens, and cost_usd for each job
3. WHEN a job log contains tool call counts, THE Metrics_Collector SHALL extract and store the tool_calls count; THE Metrics_Collector MAY extract tool call data before job completion if available in intermediate states
4. WHEN a job log contains retry information OR error information (either one present), THE Metrics_Collector SHALL extract and store `retry_count` and `error_count` fields
5. IF job log parsing fails for structural reasons (e.g. malformed JSON), THEN THE Metrics_Collector SHALL fail the entire collection process for that job; IF a field is missing or cannot be individually extracted, THEN THE Metrics_Collector SHALL store NULL for that field and log warning "metric extraction failed for <jobId>: <field>: <reason>", without failing collection for other fields
6. THE Metrics_Collector SHALL enforce numeric bounds: duration_ms ≥ 0, input_tokens ≥ 0, output_tokens ≥ 0, total_tokens ≥ 0, cost_usd ≥ 0, retry_count ≥ 0, error_count ≥ 0

### Requirement 2: Performance Analytics Computation

**User Story:** As a dashboard user, I want to see performance trends, so that I can understand if agents are getting faster or slower over time.

#### Acceptance Criteria

1. WHEN querying performance metrics, THE Analytics_Engine SHALL compute average, median, p95, and p99 duration for the specified time range
2. IF a time range filter has start > end, THEN THE Analytics_API SHALL return HTTP 400 with error "invalid time range: start must be <= end"
3. THE Performance_Metrics_API SHALL support time range filters (24h, 7d, 30d)
4. WHEN computing throughput, THE Analytics_Engine SHALL calculate jobs per hour and jobs per day from job timestamps
5. WHEN computing success rate for a time range with zero jobs, THE Analytics_Engine SHALL return NULL (not 0% or 100%); WHEN there are zero jobs in a time range, THE Analytics_Engine SHALL return NULL for all metrics including average, median, p95, and p99 duration; WHEN there are one or more jobs (positive job count), THE Analytics_Engine SHALL compute actual values for all metrics without returning NULL
6. WHEN comparing metrics across time periods, THE Analytics_Engine SHALL define the comparison window as the prior period of equivalent length (e.g., 7d compares to previous 7d); comparison windows SHALL only be defined for valid time ranges (start ≤ end)
7. THE Performance_Metrics_API SHALL cache computed metrics for 5 minutes to reduce database load, with all timestamps in UTC

### Requirement 3: Cost Analytics Computation

**User Story:** As a project manager, I want to track API costs, so that I can budget and optimize agent usage.

#### Acceptance Criteria

1. WHEN querying cost metrics for a time range, THE Analytics_Engine SHALL sum total_tokens and cost_usd across all jobs in that range
2. WHEN computing cost per job, THE Analytics_API SHALL divide total cost by total job count; IF job count is zero, return NULL
3. WHEN grouping costs by model, THE Analytics_Engine SHALL sum costs per agent/model name
4. WHEN projecting monthly cost, THE Cost_Analytics_API SHALL compute daily average over the selected time range and multiply by 30
5. WHEN identifying wasted cost, THE Analytics_Engine SHALL sum costs of jobs with status "error"
6. WHEN querying cost by workspace, THE Cost_By_Workspace_Query SHALL aggregate cost_usd, total_tokens, and job_count per workspace_id
7. WHEN computing daily cost trend, THE Daily_Cost_Trend_Query SHALL group costs by date for time series visualization

### Requirement 4: Bottleneck Detection

**User Story:** As a developer, I want to identify slow operations, so that I can focus optimization efforts on high-impact areas.

#### Acceptance Criteria

1. WHEN analyzing bottlenecks for a job type, THE Bottleneck_Detector SHALL identify jobs with duration more than 2 times the average for their type (slowdown_factor = job_duration / avg_duration_for_type); jobs NOT meeting the bottleneck threshold (slowdown_factor < 2) SHALL be explicitly marked as non-bottlenecks
2. WHEN returning slowest jobs, THE Slowest_Jobs_Query SHALL return the top 10 slowest jobs with duration, average for type, and slowdown factor; only jobs with positive slowdown_factor (slowdown_factor > 0) SHALL be included
3. IF tool call timing data is available AND concurrent job count ≥ 5, THEN THE Bottleneck_Detector SHALL identify tools with highest total time and call count
4. WHEN analyzing tool performance, THE Bottleneck_Analysis_API SHALL return the top 10 tools by total time, each with percent of total time and call count; tools with zero or negative call counts SHALL be excluded from analysis
5. WHEN detecting resource contention, THE Bottleneck_Detector SHALL identify periods with high concurrent job counts (threshold: ≥5 concurrent jobs)
6. WHEN generating recommendations, THE Recommendations_Engine SHALL only generate recommendations for jobs that are actual bottlenecks (slowdown_factor ≥ 2); THE recommendation format SHALL be: "Job type X is <slowdown_factor>x slower than average (<avg_duration>ms avg, <actual_duration>ms observed) - investigate <tool_name> (占用 <percent>% of total time)"
7. THE Bottleneck_Analysis_API SHALL assign severity: "high" if slowdown_factor ≥ 5, "medium" if 2 ≤ slowdown_factor < 5, "low" if slowdown_factor < 2

### Requirement 5: Predictive Analytics

**User Story:** As a dashboard user, I want estimated completion times for running jobs, so that I can plan my work accordingly.

#### Acceptance Criteria

1. WHEN a job is running AND there are ≥5 historical completed jobs of the same type, THE Predictive_Engine SHALL estimate remaining time as (average_duration_for_type - elapsed_time)
2. WHEN computing confidence score, THE Completion_Time_Estimator SHALL calculate it whenever coefficient of variation (CV = stddev / mean) is calculated; confidence_score = max(0, 1 - CV), strictly capping at 0 for any CV ≥ 1.0 without allowing negative intermediate values to propagate
3. IF the coefficient of variation for a job type's historical durations is > 0.5 AND other reliability conditions are met, THEN THE Predictive_Engine SHALL flag the estimate as low confidence
4. WHEN estimating success probability, THE Success_Probability_Estimator SHALL compute likelihood of success based on historical success rate for that job type
5. IF a running job's duration exceeds 2x the average, THEN THE Predictive_Engine SHALL flag it as anomalous
6. THE Anomaly_Detector SHALL compute an anomaly score (0-100) based on deviation from historical patterns
7. IF there are zero completed jobs of the same type, THEN THE Predictive_Engine SHALL return NULL for all estimates (cold-start behavior); IF there are fewer than 5 completed jobs of the same type, THEN THE Predictive_Engine SHALL return NULL for all estimates

### Requirement 6: Analytics Dashboard Integration

**User Story:** As a dashboard user, I want visual charts and graphs, so that I can quickly understand performance trends and issues.

#### Acceptance Criteria

1. THE Analytics_Dashboard_Page SHALL display performance metrics including average duration (ms), throughput (jobs/minute), and success rate (percentage)
2. THE Cost_Breakdown_Chart SHALL display cost per model as a bar chart (not pie chart)
3. THE Duration_Trend_Chart SHALL visualize average job duration over time as a line chart
4. WHEN a user selects a time range (24h, 7d, 30d), THE Analytics_Dashboard SHALL update all charts within 500ms; IF the update cannot complete within 500ms for oversized datasets OR under heavy load, THE Analytics_Dashboard SHALL show loading indicators and disable interactions until the update completes
5. WHEN a user clicks on a chart data point, THE Analytics_Dashboard SHALL drill down to show the underlying job list filtered by workspace_id, time_range, and status (if applicable)
6. WHEN a job completes, THE WebSocket_Broadcaster SHALL send metric update messages to subscribed clients within 2 seconds
7. THE Chart_Library SHALL render charts within 500 milliseconds for datasets with up to 1,000 data points; THE Chart_Library SHALL render empty charts or placeholder content when there are zero data points

### Requirement 7: Analytics API Endpoints

**User Story:** As a frontend developer, I want RESTful analytics endpoints, so that I can retrieve metrics for display in the dashboard.

#### Acceptance Criteria

1. THE Analytics_API SHALL expose `GET /api/analytics/performance` returning PerformanceMetrics for the specified workspace and time range with ≤200ms response time
2. THE Analytics_API SHALL expose `GET /api/analytics/cost` returning CostMetrics for the specified workspace and time range
3. THE Analytics_API SHALL expose `GET /api/analytics/bottlenecks` returning BottleneckAnalysis for the specified workspace
4. THE Analytics_API SHALL expose `GET /api/analytics/predictions` returning PredictiveMetrics for a specified job ID
5. IF the `range` parameter contains an invalid value, THEN THE Analytics_API SHALL return HTTP 400 with error "invalid range: must be one of [24h, 7d, 30d]"; ALL analytics endpoints that use the `range` parameter SHALL validate it and return this error for invalid values
6. IF the `workspace` parameter specifies a non-existent workspace ID, THEN THE Analytics_API SHALL return HTTP 404 with error "workspace not found"; IF the workspace exists but access is denied, THEN THE Analytics_API SHALL return HTTP 403 with error "access denied"; ALL analytics endpoints SHALL validate the `workspace` parameter and return these errors appropriately
7. IF a job ID parameter specifies a non-existent job, THEN THE Analytics_API SHALL return HTTP 404 with error "job not found"; ALL analytics endpoints SHALL validate job ID parameters and return this error for non-existent jobs

### Requirement 8: Analytics Export

**User Story:** As a data analyst, I want to export metrics to CSV or JSON, so that I can perform custom analysis in external tools.

#### Acceptance Criteria

1. THE Analytics_Export_API SHALL expose `GET /api/analytics/export`; IF the `type` parameter is missing or not in ["csv", "json"], return HTTP 400 with error "invalid or missing type parameter: must be 'csv' or 'json'"
2. WHEN exporting to CSV, THE Export_Formatter SHALL generate valid CSV with headers and quoted string fields, and set Content-Type to `text/csv`; CSV formatting SHALL only execute when the format parameter is "csv" and SHALL NOT run for JSON export requests
3. WHEN exporting to JSON, THE Export_Formatter SHALL generate valid JSON conforming to the metric type schemas, and set Content-Type to `application/json`
4. THE Analytics_Export_API SHALL support `metrics` query parameter to select which metric types to export (performance, cost, bottlenecks); IF an unrecognized metric type is provided, return HTTP 400 with error "unrecognized metric type: <type>"
5. THE Export_Response SHALL include appropriate Content-Type and Content-Disposition headers for browser download
6. WHEN filtering by date range with `from` and `to` parameters (ISO 8601 timestamps), IF `from` > `to`, THE Analytics_Export_API SHALL return HTTP 400 with error "invalid date range: from must be <= to"
7. FOR ALL exported data, the metric type schemas SHALL define: PerformanceMetrics = {avg_duration_ms, median_duration_ms, p95_duration_ms, p99_duration_ms, throughput_per_hour, success_rate_percent}; CostMetrics = {total_cost_usd, total_tokens, cost_per_job_usd, jobs_count}; BottleneckAnalysis = {job_id, duration_ms, slowdown_factor, severity}

### Requirement 9: Configuration and Environment Variables

**User Story:** As a system administrator, I want to configure analytics settings via environment variables, so that I can customize behavior without code changes.

#### Acceptance Criteria

1. THE Configuration_Loader SHALL support `ANALYTICS_ENABLED` environment variable (true/false, default: true)
2. THE Configuration_Loader SHALL support `ANALYTICS_CACHE_TTL` environment variable in seconds (range: 1-86400, default: 300); IF value is outside range, THE Configuration_Loader SHALL clamp it to the nearest valid value (1 or 86400) and log warning "ANALYTICS_CACHE_TTL <value> adjusted to <clamped_value>"
3. THE Configuration_Loader SHALL validate all environment variables on startup and log error messages in format "Configuration error: <variable_name>: <specific_issue>" for invalid values

### Requirement 10: Error Handling and Resilience

**User Story:** As a system administrator, I want the system to handle errors gracefully, so that partial failures don't affect the rest of the monitor.

#### Acceptance Criteria

1. IF an analytics query exceeds 30 seconds, THEN THE Analytics_API SHALL abort the query and return HTTP 503 with error "computation timed out after 30 seconds"; HTTP 503 SHALL only be returned for timeout scenarios, not for other error conditions such as resource exhaustion or invalid query syntax
2. IF metrics collection fails for a job, THE Metrics_Collector SHALL log the error and continue processing other jobs

### Requirement 11: Logging and Observability

**User Story:** As a developer, I want detailed logs, so that I can diagnose issues and monitor analytics performance.

#### Acceptance Criteria

1. WHEN cache_logging_enabled is true AND log level is INFO or higher, THE Analytics_Engine SHALL log cache hit/miss rates every 5 minutes
2. THE Error_Logger SHALL include stack traces with severity levels (DEBUG < INFO < WARN < ERROR < FATAL) for all unexpected errors

### Requirement 12: Testing and Verification

**User Story:** As a developer, I want comprehensive tests, so that I can refactor with confidence and catch regressions early.

#### Acceptance Criteria

1. THE Test_Suite SHALL include property-based tests for analytics calculations: all duration/cost metrics ≥ 0, success_rate_percent in range [0, 100], retry_count ≥ 0, error_count ≥ 0
2. THE Test_Suite SHALL include performance tests verifying API response times: performance endpoint ≤200ms, cost endpoint ≤200ms, bottlenecks endpoint ≤500ms
