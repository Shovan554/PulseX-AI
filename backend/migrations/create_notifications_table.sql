CREATE TABLE notifications (
    id SERIAL PRIMARY KEY,
    content TEXT NOT NULL,
    received_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Simple index for timestamp-based queries
CREATE INDEX idx_notifications_received_at ON notifications(received_at);

-- Example insertion
INSERT INTO notifications (content) VALUES 
    ('Your deep sleep duration has decreased by 45% compared to your weekly average. Consider adjusting your bedtime routine to improve sleep quality.');