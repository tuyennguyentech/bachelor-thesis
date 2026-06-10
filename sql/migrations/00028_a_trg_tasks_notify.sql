-- +goose Up
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION notify_task_created() RETURNS TRIGGER AS $$
BEGIN
    PERFORM pg_notify('task_created', NEW.id::text);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- +goose StatementEnd

CREATE TRIGGER tasks_notify_created
    AFTER INSERT ON tasks
    FOR EACH ROW EXECUTE FUNCTION notify_task_created();

-- +goose Down
DROP TRIGGER IF EXISTS tasks_notify_created ON tasks;
DROP FUNCTION IF EXISTS notify_task_created();
