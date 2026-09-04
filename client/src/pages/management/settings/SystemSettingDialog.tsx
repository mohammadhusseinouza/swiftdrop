import { useEffect, useState } from 'react';

import { useUpdateSystemSettingMutation } from '../../../services/settingsApi';
import {
  getApiErrorMessage,
  type UnknownApiError,
} from '../../../services/apiError';
import type { SystemSettingSummary } from '../../../services/domain.types';

import { ReferenceDialog } from './ReferenceDialog';
import { TextField, SelectField } from '../../../components/forms/Field';

type Primitive = 'string' | 'number' | 'boolean';

function primitiveKind(value: unknown): Primitive | null {
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return null;
}

/**
 * Type-aware editor for a SINGLE existing system_settings row whose value is
 * a string / number / boolean primitive. Objects / arrays are not editable
 * through this generic UI (no JSON textarea — §40). Sensitive rows never
 * reach this dialog (the caller gates on `!isSensitive`).
 */
export function SystemSettingDialog({
  setting,
  onClose,
  saving,
}: {
  setting: SystemSettingSummary | null;
  onClose: () => void;
  saving?: boolean;
}) {
  const [update, { isLoading }] = useUpdateSystemSettingMutation();
  const [text, setText] = useState('');
  const [bool, setBool] = useState('false');
  const [error, setError] = useState<string | null>(null);

  const kind = setting ? primitiveKind(setting.value) : null;

  useEffect(() => {
    if (!setting) return;
    setError(null);
    if (kind === 'boolean') setBool(setting.value ? 'true' : 'false');
    else setText(setting.value == null ? '' : String(setting.value));
  }, [setting, kind]);

  if (!setting) return null;

  const editable = kind !== null;

  const submit = () => {
    setError(null);
    let value: unknown;
    if (kind === 'boolean') value = bool === 'true';
    else if (kind === 'number') {
      const n = Number(text);
      if (!Number.isFinite(n)) {
        setError('Enter a valid number.');
        return;
      }
      value = n;
    } else value = text;

    void (async () => {
      try {
        await update({ key: setting.key, body: { value } }).unwrap();
        onClose();
      } catch (e) {
        setError(getApiErrorMessage(e as UnknownApiError));
      }
    })();
  };

  return (
    <ReferenceDialog
      open={!!setting}
      title={`Edit ${setting.key}`}
      description={setting.description ?? undefined}
      submitLabel="Save setting"
      submitLoading={isLoading || !!saving}
      submitDisabled={!editable}
      error={error}
      onSubmit={submit}
      onClose={onClose}
    >
      {!editable ? (
        <p className="text-sm text-ink-muted">
          This setting holds a structured value and cannot be edited from this
          generic screen. Update it through an approved dedicated workflow.
        </p>
      ) : kind === 'boolean' ? (
        <SelectField
          label="Value"
          value={bool}
          onChange={(e) => setBool(e.target.value)}
          options={[
            { value: 'true', label: 'On' },
            { value: 'false', label: 'Off' },
          ]}
        />
      ) : (
        <TextField
          label="Value"
          type={kind === 'number' ? 'number' : 'text'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          hint={`Stored as a ${kind}.`}
        />
      )}
    </ReferenceDialog>
  );
}
