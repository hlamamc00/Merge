import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, getToken } from '../api/client';
import type { ImportJob, ImportPreview, ImportResult } from '../api/types.onboarding';
import { Badge, Button, Card, Checkbox, ErrorBanner, InfoBanner, PageHeader, Table } from '../components/ui';
import { fmtDateTime } from '../lib/format';

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function ImportWorkersPage() {
  const [file, setFile] = useState<{ name: string; base64: string } | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [invite, setInvite] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const jobs = useQuery({ queryKey: ['import-jobs'], queryFn: () => api.get<ImportJob[]>('/onboarding/import/jobs') });

  const choose = async (f: File | undefined) => {
    setPreview(null);
    setResult(null);
    setError(null);
    if (!f) return setFile(null);
    setBusy(true);
    try {
      const base64 = await readAsBase64(f);
      setFile({ name: f.name, base64 });
      setPreview(await api.post<ImportPreview>('/onboarding/import/preview', { fileName: f.name, contentBase64: base64 }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!file || !preview) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api.post<ImportResult>(`/onboarding/import/${preview.jobId}/apply`, { fileName: file.name, contentBase64: file.base64, invite }));
      void jobs.refetch();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const downloadTemplate = async () => {
    const res = await fetch('/api/v1/onboarding/import/template.csv', { headers: { Authorization: `Bearer ${getToken() ?? ''}` } });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'merge-worker-import-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-5">
      <PageHeader title="Import workers" description="Add or update your whole team from a spreadsheet, with their certificates, and invite them to log in." actions={<Button variant="secondary" onClick={downloadTemplate}>Download template (CSV)</Button>} />
      <ErrorBanner error={error} />
      <Card title="1. Choose a file" description="CSV or Excel (.xlsx). The first row must be the column headers from the template. Workers already on your list (matched by email) are updated, not duplicated.">
        <input type="file" accept=".csv,.xlsx,.xlsm,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => void choose(e.target.files?.[0])} className="text-sm" disabled={busy} />
        {file && <div className="mt-2 text-xs text-slate-500">{file.name}</div>}
      </Card>
      {preview && !result && (
        <Card title="2. Check the preview" description={`${preview.validRows} of ${preview.totalRows} rows can be imported${preview.errors.length ? `; ${preview.errors.length} need fixing in the file first` : ''}.`}>
          {preview.errors.length > 0 && (
            <InfoBanner tone="amber" className="mb-3">
              Rows with problems are skipped. Fix them in your file and upload again to include them.
            </InfoBanner>
          )}
          {preview.errors.length > 0 && (
            <Table rows={preview.errors} rowKey={(r) => String(r.row)} columns={[{ key: 'row', header: 'Row', render: (r) => r.row }, { key: 'message', header: 'Problem', render: (r) => r.message }]} />
          )}
          <div className="mt-4 text-sm font-medium text-slate-900">Sample of rows that will be imported</div>
          <Table
            rows={preview.sample}
            rowKey={(r) => String(r.line)}
            columns={[
              { key: 'name', header: 'Name', render: (r) => r.name },
              { key: 'email', header: 'Email', render: (r) => r.email ?? '—' },
              { key: 'role', header: 'Role', render: (r) => r.jobRole.toLowerCase().replace(/_/g, ' ') },
              { key: 'skills', header: 'Skills', render: (r) => r.skills.length },
              { key: 'docs', header: 'Documents', render: (r) => r.documents },
              { key: 'invite', header: 'Invite', render: (r) => (r.invite ? <Badge tone="green">yes</Badge> : <Badge>no</Badge>) },
            ]}
          />
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <Checkbox label={`Invite ${preview.invitable} worker(s) by email to set their own password`} hint="Only rows with invite = yes and an email address. Each gets a link that works for 7 days." checked={invite} onChange={(e) => setInvite(e.target.checked)} />
            <Button onClick={apply} loading={busy} disabled={preview.validRows === 0}>
              Import {preview.validRows} worker(s)
            </Button>
          </div>
        </Card>
      )}
      {result && (
        <Card title="3. Done">
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="Created" value={result.created} />
            <Stat label="Updated" value={result.updated} />
            <Stat label="Documents added" value={result.documents} />
            <Stat label="Invited by email" value={result.invited} />
          </div>
          {result.errors.length > 0 && (
            <div className="mt-4">
              <div className="text-sm font-medium text-slate-900">{result.failed} row(s) were not imported</div>
              <Table rows={result.errors} rowKey={(r) => String(r.row)} columns={[{ key: 'row', header: 'Row', render: (r) => r.row }, { key: 'message', header: 'Problem', render: (r) => r.message }]} />
            </div>
          )}
          <InfoBanner tone="blue" className="mt-4">
            Imported documents are unverified unless the file said <code>verified = yes</code>. Verify them under <Link to="/compliance" className="font-medium underline">Compliance</Link> before these workers can be lent out. <Link to="/workers" className="font-medium underline">Go to Workers</Link>.
          </InfoBanner>
        </Card>
      )}
      <Card title="Previous imports">
        <Table
          rows={jobs.data ?? []}
          rowKey={(j) => j.id}
          empty="No imports yet."
          columns={[
            { key: 'when', header: 'When', render: (j) => fmtDateTime(j.appliedAt ?? j.createdAt) },
            { key: 'file', header: 'File', render: (j) => j.fileName ?? '—' },
            { key: 'status', header: 'Status', render: (j) => <Badge tone={j.status === 'APPLIED' ? 'green' : 'slate'}>{j.status.toLowerCase()}</Badge> },
            { key: 'rows', header: 'Rows', render: (j) => j.totalRows },
            { key: 'created', header: 'Created / updated / invited', render: (j) => `${j.createdCount} / ${j.updatedCount} / ${j.invitedCount}` },
            { key: 'failed', header: 'Skipped', render: (j) => j.failedCount },
          ]}
        />
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-2xl font-semibold text-slate-900">{value}</div>
    </div>
  );
}
