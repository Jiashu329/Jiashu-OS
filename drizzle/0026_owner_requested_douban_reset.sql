-- One-time cleanup explicitly requested by the verified Site owner.
-- Protection release 77 must be active before this atomic D1 migration batch.
-- The exact owner and epoch zero were verified before preparing this action.
-- Fresh databases and other identities safely skip this maintenance action.
-- The normal migration ledger provides once-only application. A manual replay
-- deliberately fails the NOT NULL probe before deleting any newly synced data.
-- The fixed hash identifies this administrative maintenance command, not an
-- interactive reset API preview. The receipt holds aggregate counters only.
INSERT INTO douban_data_resets
  (user_id,data_epoch,last_request_id,last_request_hash,last_receipt_json,created_at,updated_at)
SELECT owner.user_id,1,'c3e6432f-58fd-41bb-8eb9-e97ea15a092d',
  'e695ee755dcc346ae31a8cf57694ab5b2e3808c7da9933d453aaccccfd2628b4',
  json_object('requestId','c3e6432f-58fd-41bb-8eb9-e97ea15a092d','epoch',1,'deleted',snapshot.total,
    'counts',json_object('all',snapshot.total,'screen',snapshot.screen,'movie',snapshot.movie,
      'series',snapshot.series,'book',snapshot.book,'music',snapshot.music),
    'clearedAt',clock.cleared_at),clock.cleared_at,clock.cleared_at
FROM app_owner_identity owner
CROSS JOIN (SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS cleared_at) clock
CROSS JOIN (SELECT COUNT(*) AS total,
  COALESCE(SUM(kind='screen'),0) AS screen,COALESCE(SUM(kind='movie'),0) AS movie,
  COALESCE(SUM(kind='series'),0) AS series,COALESCE(SUM(kind='book'),0) AS book,
  COALESCE(SUM(kind='music'),0) AS music
  FROM douban_items WHERE user_id='y14x9HXn9E8I8zpGRCvNTur8iFO3LTptBeNGDPLF0xsRXRsGnZ7Uap') snapshot
WHERE owner.id='owner' AND owner.user_id='y14x9HXn9E8I8zpGRCvNTur8iFO3LTptBeNGDPLF0xsRXRsGnZ7Uap'
  AND COALESCE((SELECT data_epoch FROM douban_data_resets WHERE user_id='y14x9HXn9E8I8zpGRCvNTur8iFO3LTptBeNGDPLF0xsRXRsGnZ7Uap'),0)=0
ON CONFLICT(user_id) DO NOTHING;
--> statement-breakpoint
-- Fresh or differently owned databases are intentionally no-ops throughout.
-- For the exact target, a repeated, stale, or competing clear violates receipt
-- NOT NULL here. D1 must roll the complete batch back; never split statements.
UPDATE douban_data_resets SET last_receipt_json=CASE
  WHEN changes()=1 AND data_epoch=1 AND last_request_id='c3e6432f-58fd-41bb-8eb9-e97ea15a092d'
    AND last_request_hash='e695ee755dcc346ae31a8cf57694ab5b2e3808c7da9933d453aaccccfd2628b4'
  THEN last_receipt_json ELSE NULL END
WHERE user_id='y14x9HXn9E8I8zpGRCvNTur8iFO3LTptBeNGDPLF0xsRXRsGnZ7Uap'
  AND EXISTS(SELECT 1 FROM app_owner_identity WHERE id='owner' AND user_id='y14x9HXn9E8I8zpGRCvNTur8iFO3LTptBeNGDPLF0xsRXRsGnZ7Uap');
--> statement-breakpoint
DELETE FROM douban_items
WHERE user_id='y14x9HXn9E8I8zpGRCvNTur8iFO3LTptBeNGDPLF0xsRXRsGnZ7Uap'
  AND EXISTS(SELECT 1 FROM app_owner_identity WHERE id='owner' AND user_id='y14x9HXn9E8I8zpGRCvNTur8iFO3LTptBeNGDPLF0xsRXRsGnZ7Uap')
  AND EXISTS(SELECT 1 FROM douban_data_resets WHERE user_id='y14x9HXn9E8I8zpGRCvNTur8iFO3LTptBeNGDPLF0xsRXRsGnZ7Uap'
    AND data_epoch=1 AND last_request_id='c3e6432f-58fd-41bb-8eb9-e97ea15a092d');
--> statement-breakpoint
DELETE FROM douban_sync_runs
WHERE user_id='y14x9HXn9E8I8zpGRCvNTur8iFO3LTptBeNGDPLF0xsRXRsGnZ7Uap'
  AND EXISTS(SELECT 1 FROM app_owner_identity WHERE id='owner' AND user_id='y14x9HXn9E8I8zpGRCvNTur8iFO3LTptBeNGDPLF0xsRXRsGnZ7Uap')
  AND EXISTS(SELECT 1 FROM douban_data_resets WHERE user_id='y14x9HXn9E8I8zpGRCvNTur8iFO3LTptBeNGDPLF0xsRXRsGnZ7Uap'
    AND data_epoch=1 AND last_request_id='c3e6432f-58fd-41bb-8eb9-e97ea15a092d');
--> statement-breakpoint
DELETE FROM douban_import_receipts
WHERE user_id='y14x9HXn9E8I8zpGRCvNTur8iFO3LTptBeNGDPLF0xsRXRsGnZ7Uap'
  AND EXISTS(SELECT 1 FROM app_owner_identity WHERE id='owner' AND user_id='y14x9HXn9E8I8zpGRCvNTur8iFO3LTptBeNGDPLF0xsRXRsGnZ7Uap')
  AND EXISTS(SELECT 1 FROM douban_data_resets WHERE user_id='y14x9HXn9E8I8zpGRCvNTur8iFO3LTptBeNGDPLF0xsRXRsGnZ7Uap'
    AND data_epoch=1 AND last_request_id='c3e6432f-58fd-41bb-8eb9-e97ea15a092d');
--> statement-breakpoint
UPDATE douban_connections
SET revision=revision+1,updated_at=MAX(updated_at,
  (SELECT updated_at FROM douban_data_resets WHERE user_id='y14x9HXn9E8I8zpGRCvNTur8iFO3LTptBeNGDPLF0xsRXRsGnZ7Uap'))
WHERE user_id='y14x9HXn9E8I8zpGRCvNTur8iFO3LTptBeNGDPLF0xsRXRsGnZ7Uap'
  AND EXISTS(SELECT 1 FROM app_owner_identity WHERE id='owner' AND user_id='y14x9HXn9E8I8zpGRCvNTur8iFO3LTptBeNGDPLF0xsRXRsGnZ7Uap')
  AND EXISTS(SELECT 1 FROM douban_data_resets WHERE user_id='y14x9HXn9E8I8zpGRCvNTur8iFO3LTptBeNGDPLF0xsRXRsGnZ7Uap'
    AND data_epoch=1 AND last_request_id='c3e6432f-58fd-41bb-8eb9-e97ea15a092d');
--> statement-breakpoint
SELECT last_receipt_json AS receipt_json FROM douban_data_resets
WHERE user_id='y14x9HXn9E8I8zpGRCvNTur8iFO3LTptBeNGDPLF0xsRXRsGnZ7Uap' AND data_epoch=1 AND last_request_id='c3e6432f-58fd-41bb-8eb9-e97ea15a092d'
  AND EXISTS(SELECT 1 FROM app_owner_identity WHERE id='owner' AND user_id='y14x9HXn9E8I8zpGRCvNTur8iFO3LTptBeNGDPLF0xsRXRsGnZ7Uap');
-- The final read is counter-only; production must be verified after deployment.
