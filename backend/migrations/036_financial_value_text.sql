ALTER TABLE opportunities
ADD COLUMN total_value_text text NOT NULL DEFAULT '',
ADD COLUMN down_payment_text text NOT NULL DEFAULT '';
