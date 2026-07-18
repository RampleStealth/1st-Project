WITH reconciled AS (
  UPDATE mailbox_permission_state permission
  SET write_capability = 'read_only',
      granted_scopes = mailbox.granted_scopes,
      upgrade_attempt_id = NULL,
      upgrade_expires_at = NULL,
      updated_at = now()
  FROM mailbox_accounts mailbox
  WHERE permission.mailbox_account_id = mailbox.id
    AND permission.write_capability = 'write_granted'
    AND NOT ('https://www.googleapis.com/auth/gmail.modify' = ANY(mailbox.granted_scopes))
  RETURNING permission.mailbox_account_id
)
INSERT INTO audit_events(actor_type,event_type,object_type,object_id,correlation_id,metadata)
SELECT 'system','gmail.write_permission_reconciled','mailbox_account',mailbox_account_id,gen_random_uuid(),
       '{"reason":"active_credential_is_read_only"}'::jsonb
FROM reconciled;
