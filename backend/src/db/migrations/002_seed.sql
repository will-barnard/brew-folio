-- Starting books, streams and categories. All editable in the app.
-- tax_line values are Schedule C line hints for the accountant, not advice.

INSERT INTO entities (name, kind) VALUES ('Personal', 'personal');

INSERT INTO streams (entity_id, name, kind, color, sort)
SELECT id, s.name, s.kind, s.color, s.sort FROM entities,
  (VALUES ('W2', 'w2', '#7aa2c9', 1),
          ('Dev', 'schedule_c', '#8fbf9f', 2),
          ('Music', 'schedule_c', '#d4a373', 3),
          ('Other', 'other', '#a59bc4', 4)) AS s(name, kind, color, sort)
WHERE entities.name = 'Personal';

CREATE FUNCTION pg_temp.cat(p_parent text, p_name text, p_kind text,
                            p_tax text DEFAULT NULL, p_biz boolean DEFAULT false,
                            p_key text DEFAULT NULL) RETURNS void AS $$
  INSERT INTO categories (parent_id, name, kind, tax_line, is_business, system_key)
  VALUES ((SELECT id FROM categories WHERE name = p_parent AND parent_id IS NULL),
          p_name, p_kind, p_tax, p_biz, p_key);
$$ LANGUAGE sql;

-- Income
SELECT pg_temp.cat(NULL, 'Income', 'income');
SELECT pg_temp.cat('Income', 'Wages', 'income', NULL, false, 'wages');
SELECT pg_temp.cat('Income', 'Client payments', 'income', 'C-1', true);
SELECT pg_temp.cat('Income', 'Gig pay', 'income', 'C-1', true);
SELECT pg_temp.cat('Income', 'Sales', 'income', 'C-1', true);
SELECT pg_temp.cat('Income', 'Interest', 'income');
SELECT pg_temp.cat('Income', 'Refunds', 'income', NULL, false, 'refund');
SELECT pg_temp.cat('Income', 'Reimbursements', 'income', NULL, false, 'reimbursement');
SELECT pg_temp.cat('Income', 'Other income', 'income');

-- Money moving between your own accounts. Excluded from income and spending.
SELECT pg_temp.cat(NULL, 'Transfers', 'transfer');
SELECT pg_temp.cat('Transfers', 'Transfer', 'transfer', NULL, false, 'transfer');
SELECT pg_temp.cat('Transfers', 'Credit card payment', 'transfer', NULL, false, 'cc_payment');
SELECT pg_temp.cat('Transfers', 'Owner contribution', 'transfer', NULL, false, 'owner_contribution');
SELECT pg_temp.cat('Transfers', 'Owner draw', 'transfer', NULL, false, 'owner_draw');

-- Household
SELECT pg_temp.cat(NULL, 'Home', 'expense');
SELECT pg_temp.cat('Home', 'Rent', 'expense');
SELECT pg_temp.cat('Home', 'Utilities', 'expense');
SELECT pg_temp.cat('Home', 'Internet & phone', 'expense');
SELECT pg_temp.cat('Home', 'Household supplies', 'expense');
SELECT pg_temp.cat('Home', 'Furnishings & repairs', 'expense');

SELECT pg_temp.cat(NULL, 'Food', 'expense');
SELECT pg_temp.cat('Food', 'Groceries', 'expense');
SELECT pg_temp.cat('Food', 'Restaurants', 'expense');
SELECT pg_temp.cat('Food', 'Coffee', 'expense');
SELECT pg_temp.cat('Food', 'Bars', 'expense');

SELECT pg_temp.cat(NULL, 'Transport', 'expense');
SELECT pg_temp.cat('Transport', 'Gas', 'expense');
SELECT pg_temp.cat('Transport', 'Parking & tolls', 'expense');
SELECT pg_temp.cat('Transport', 'Rideshare & transit', 'expense');
SELECT pg_temp.cat('Transport', 'Auto insurance', 'expense');
SELECT pg_temp.cat('Transport', 'Auto maintenance', 'expense');

SELECT pg_temp.cat(NULL, 'Life', 'expense');
SELECT pg_temp.cat('Life', 'Shopping', 'expense');
SELECT pg_temp.cat('Life', 'Entertainment', 'expense');
SELECT pg_temp.cat('Life', 'Subscriptions', 'expense');
SELECT pg_temp.cat('Life', 'Health', 'expense');
SELECT pg_temp.cat('Life', 'Personal care', 'expense');
SELECT pg_temp.cat('Life', 'Travel', 'expense');
SELECT pg_temp.cat('Life', 'Gifts & donations', 'expense');
SELECT pg_temp.cat('Life', 'Education', 'expense');
SELECT pg_temp.cat('Life', 'Pets', 'expense');

SELECT pg_temp.cat(NULL, 'Gear', 'expense');
SELECT pg_temp.cat('Gear', 'Gear purchase', 'expense', NULL, false, 'gear_purchase');
SELECT pg_temp.cat('Gear', 'Gear repair & parts', 'expense');

SELECT pg_temp.cat(NULL, 'Financial', 'expense');
SELECT pg_temp.cat('Financial', 'Bank fees', 'expense');
SELECT pg_temp.cat('Financial', 'Interest charged', 'expense');
SELECT pg_temp.cat('Financial', 'Federal estimated tax', 'expense', NULL, false, 'tax_federal');
SELECT pg_temp.cat('Financial', 'State estimated tax', 'expense', NULL, false, 'tax_state');
SELECT pg_temp.cat('Financial', 'Other taxes', 'expense');

-- Business expenses. Tag with a stream (Dev / Music) to land on that P&L.
SELECT pg_temp.cat(NULL, 'Business', 'expense');
SELECT pg_temp.cat('Business', 'Hosting & cloud', 'expense', 'C-27a', true);
SELECT pg_temp.cat('Business', 'Software & subscriptions', 'expense', 'C-27a', true);
SELECT pg_temp.cat('Business', 'Payment processing fees', 'expense', 'C-10', true);
SELECT pg_temp.cat('Business', 'Contract labor', 'expense', 'C-11', true);
SELECT pg_temp.cat('Business', 'Advertising', 'expense', 'C-8', true);
SELECT pg_temp.cat('Business', 'Legal & professional', 'expense', 'C-17', true);
SELECT pg_temp.cat('Business', 'Office expense', 'expense', 'C-18', true);
SELECT pg_temp.cat('Business', 'Equipment', 'expense', 'C-13', true);
SELECT pg_temp.cat('Business', 'Supplies', 'expense', 'C-22', true);
SELECT pg_temp.cat('Business', 'Repairs & maintenance', 'expense', 'C-21', true);
SELECT pg_temp.cat('Business', 'Travel', 'expense', 'C-24a', true);
SELECT pg_temp.cat('Business', 'Meals', 'expense', 'C-24b', true);
SELECT pg_temp.cat('Business', 'Car & truck', 'expense', 'C-9', true);
SELECT pg_temp.cat('Business', 'Licenses & fees', 'expense', 'C-23', true);
SELECT pg_temp.cat('Business', 'Education', 'expense', 'C-27a', true);
SELECT pg_temp.cat('Business', 'Other business', 'expense', 'C-27a', true);

UPDATE categories c SET sort = s.rn FROM (
  SELECT id, row_number() OVER (PARTITION BY parent_id ORDER BY id) AS rn FROM categories
) s WHERE s.id = c.id;
