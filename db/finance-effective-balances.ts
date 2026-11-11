/** One effective version per immutable original balance; voids never enter calculations. */
export const EFFECTIVE_FINANCE_BALANCES = `SELECT b.sequence, b.id, b.user_id, b.account_id,
  COALESCE(c.amount_minor, b.amount_minor) AS amount_minor,
  COALESCE(c.as_of_date, b.as_of_date) AS as_of_date,
  COALESCE(c.note, b.note) AS note, b.created_at,
  COALESCE(c.revision, 0) AS revision
  FROM finance_balance_entries b LEFT JOIN finance_balance_changes c ON c.sequence = (
    SELECT latest.sequence FROM finance_balance_changes latest
    WHERE latest.user_id = b.user_id AND latest.entry_id = b.id
    ORDER BY latest.revision DESC LIMIT 1
  ) WHERE c.action IS NULL OR c.action <> 'void'`;
