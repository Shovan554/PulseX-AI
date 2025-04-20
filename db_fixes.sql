-- For health_realtime table
ALTER TABLE health_realtime 
DROP CONSTRAINT IF EXISTS health_realtime_metric_timestamp_unique;

ALTER TABLE health_realtime 
ADD CONSTRAINT health_realtime_metric_timestamp_value_unique 
UNIQUE (metric_name, timestamp, value);

-- For health_aggregated table
ALTER TABLE health_aggregated 
ADD CONSTRAINT health_aggregated_metric_timestamp_unique 
UNIQUE (metric_name, timestamp);
