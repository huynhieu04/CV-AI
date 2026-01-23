import { CommonModule } from '@angular/common';
import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';

import { CvApiService } from '../../../services/cv-api.service';
import {
  CandidateRow,
  CandidateStatus,
  AiMatchSummary,
  AiClassificationState,
} from '../../../models/ai-classification.model';
import { AiClassificationStateService } from '../../../services/ai-classification-state.service';

type CvBatchItem = {
  key: string;                 // candidateId hoặc cvFileId hoặc index
  label: string;               // tên hiển thị
  rows: CandidateRow[];        // danh sách job matches của CV này
  summary: AiMatchSummary;     // summary của CV này
  firstRow: CandidateRow | null;
  error: string | null;
};

@Component({
  selector: 'app-ai-classification',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './ai-classification.html',
  styleUrls: ['./ai-classification.scss'],
})
export class AiClassificationComponent implements OnInit {
  // Upload (multiple)
  selectedFiles: File[] = [];
  selectedFileName: string | null = null;

  // UI states
  isMatching = false;
  isLoadingFromDb = false;
  errorMessage: string | null = null;

  // ✅ NEW: Batch results
  batchItems: CvBatchItem[] = [];
  activeBatchKey: string | null = null; // CV đang chọn để filter

  // Table + right detail (theo CV đang chọn)
  candidates: CandidateRow[] = [];
  selectedCandidate: CandidateRow | null = null;
  matchTags: string[] = [];
  matchSummary: AiMatchSummary | null = null;

  constructor(
    private cvApi: CvApiService,
    private cdr: ChangeDetectorRef,
    private stateService: AiClassificationStateService,
    private route: ActivatedRoute
  ) { }

  ngOnInit(): void {
    this.restoreState();

    // ✅ load theo candidateId trên URL (kể cả refresh/restart)
    this.route.queryParams.subscribe((params) => {
      const candidateId = params['candidateId'];
      if (candidateId) this.loadAiResultFromDb(candidateId);
    });
  }

  /* =========================
     STATE PERSIST
  ========================= */
  private restoreState() {
    const snapshot = this.stateService.getSnapshot();
    if (!snapshot) return;

    // các field cũ
    this.candidates = snapshot.candidates;
    this.selectedCandidate = snapshot.selectedCandidate;
    this.matchTags = snapshot.matchTags;
    this.matchSummary = snapshot.matchSummary;
    this.errorMessage = snapshot.errorMessage;

    // các field mới (nếu chưa có thì bỏ qua)
    const anySnap = snapshot as any;
    this.batchItems = anySnap.batchItems || [];
    this.activeBatchKey = anySnap.activeBatchKey || null;
  }

  private saveState() {
    const state: AiClassificationState = {
      candidates: this.candidates,
      selectedCandidate: this.selectedCandidate,
      matchTags: this.matchTags,
      matchSummary: this.matchSummary,
      errorMessage: this.errorMessage,
    };

    // đính kèm extra state
    (state as any).batchItems = this.batchItems;
    (state as any).activeBatchKey = this.activeBatchKey;

    this.stateService.setState(state);
  }

  /* =========================
     UPLOAD HANDLERS
  ========================= */

  onFilesChange(event: Event, inputEl?: HTMLInputElement) {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files || []);

    if (!files.length) {
      this.selectedFiles = [];
      this.selectedFileName = null;
      return;
    }

    // (optional) loại trùng theo name+size
    const map = new Map<string, File>();
    for (const f of files) map.set(`${f.name}-${f.size}`, f);

    this.selectedFiles = Array.from(map.values());

    if (this.selectedFiles.length === 1) {
      this.selectedFileName = this.selectedFiles[0].name;
    } else {
      const preview = this.selectedFiles.slice(0, 2).map((f) => f.name).join(', ');
      const more = this.selectedFiles.length > 2 ? ` +${this.selectedFiles.length - 2} file` : '';
      this.selectedFileName = `${preview}${more}`;
    }

    this.errorMessage = null;

    // ✅ reset input để chọn lại cùng file vẫn trigger change
    if (inputEl) inputEl.value = '';
  }

  clearSelectedFiles() {
    this.selectedFiles = [];
    this.selectedFileName = null;
    this.errorMessage = null;

    this.batchItems = [];
    this.activeBatchKey = null;

    this.candidates = [];
    this.selectedCandidate = null;
    this.matchTags = [];
    this.matchSummary = null;

    this.saveState();
    this.cdr.detectChanges();
  }

  onRunMatching() {
    if (!this.selectedFiles.length) {
      this.errorMessage = 'Vui lòng chọn ít nhất 1 file CV trước khi chạy AI matching.';
      return;
    }

    this.isMatching = true;
    this.errorMessage = null;
    this.cdr.markForCheck();

    // ===== CASE 1: 1 file =====
    if (this.selectedFiles.length === 1) {
      const file = this.selectedFiles[0];

      this.cvApi.uploadCv(file).subscribe({
        next: (res: any) => {
          const built = this.buildUiFromUploadResponse(res);

          const key = String(res?.candidate?._id || res?.cvFile?._id || 'single');
          const label = this.buildCvLabel(res, file.name);

          this.batchItems = [
            {
              key,
              label,
              rows: built.rows,
              summary: built.summary,
              firstRow: built.firstRow,
              error: built.error,
            },
          ];

          // set active = CV này
          this.setActiveCv(key);

          // show error nếu có
          this.errorMessage = built.error;

          this.isMatching = false;
          this.saveState();
          this.cdr.detectChanges();
        },
        error: (err) => {
          this.isMatching = false;
          this.errorMessage = err?.error?.message || 'Upload CV thất bại.';
          this.cdr.detectChanges();
        },
      });

      return;
    }

    // ===== CASE 2: Batch =====
    this.cvApi.uploadCvBatch(this.selectedFiles).subscribe({
      next: (res: any) => {
        const results: any[] = Array.isArray(res?.results) ? res.results : [];

        const oks = results.filter((x) => x?.ok && x?.matchResult);
        if (!oks.length) {
          this.isMatching = false;
          this.resetUi('Batch upload xong nhưng không có CV nào trả kết quả AI hợp lệ.');
          return;
        }

        // build batch items (mỗi CV -> 1 item)
        const items: CvBatchItem[] = oks.map((item, idx) => {
          const built = this.buildUiFromUploadResponse(item);
          const key = String(item?.candidate?._id || item?.cvFile?._id || `cv_${idx}`);
          const fallbackFileName = this.selectedFiles[idx]?.name || `CV ${idx + 1}`;
          const label = this.buildCvLabel(item, fallbackFileName);

          return {
            key,
            label,
            rows: built.rows,
            summary: built.summary,
            firstRow: built.firstRow,
            error: built.error,
          };
        });

        this.batchItems = items;

        // auto chọn CV đầu tiên có rows
        const firstHasRows = items.find((i) => i.rows.length)?.key || items[0].key;
        this.setActiveCv(firstHasRows);

        // báo fail nếu có
        const failed = results.filter((x) => !x?.ok);
        this.errorMessage = failed.length
          ? `(${failed.length}/${results.length} CV upload lỗi. Kiểm tra định dạng/dung lượng.)`
          : null;

        this.isMatching = false;
        this.saveState();
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.isMatching = false;
        this.errorMessage = err?.error?.message || 'Upload batch thất bại.';
        this.cdr.detectChanges();
      },
    });
  }

  /* =========================
     FILTER PER CV
  ========================= */

  setActiveCv(key: string) {
    this.activeBatchKey = key;

    const item = this.batchItems.find((x) => x.key === key);
    if (!item) return;

    // ✅ Table chỉ show rows của CV đang chọn
    this.candidates = item.rows;

    // ✅ Right panel chi tiết: default = top match
    this.selectedCandidate = item.firstRow;
    this.matchTags = item.firstRow?.tags || [];
    this.matchSummary = item.summary;

    // nếu CV này không có rows -> show error riêng (optional)
    // nhưng mình không ghi đè errorMessage tổng batch
    // bạn muốn thì bật dòng dưới:
    // this.errorMessage = item.error;

    this.saveState();
    this.cdr.detectChanges();
  }

  isActiveCv(key: string): boolean {
    return this.activeBatchKey === key;
  }

  /* =========================
     BUILD UI FROM RESPONSE
  ========================= */

  private buildUiFromUploadResponse(res: any) {
    const matchResult = res?.matchResult || {};
    const summaryRaw = matchResult?.candidateSummary || {};
    const matches: any[] = Array.isArray(matchResult?.matches) ? matchResult.matches : [];

    const summary: AiMatchSummary = {
      mainSkills: summaryRaw.mainSkills || [],
      mainDomains: summaryRaw.mainDomains || [],
      seniority: summaryRaw.seniority || '',
    };

    if (!matches.length) {
      return { rows: [], summary, firstRow: null, error: 'AI chưa tìm được vị trí phù hợp cho CV này.' };
    }

    const filtered = matches
      .slice()
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .filter((m) => (m.score ?? 0) >= 10);

    if (!filtered.length) {
      return { rows: [], summary, firstRow: null, error: 'Không có vị trí nào đạt mức phù hợp tối thiểu (≥ 10%).' };
    }

    const name = res?.candidate?.email || res?.candidate?.fullName || 'Ứng viên đã upload';

    const rows: CandidateRow[] = filtered.map((m) => {
      const score = m.score ?? 0;
      const status = this.mapStatus(m.label, score);

      return {
        name,
        recommendedJob: `${m.jobTitle} (${m.jobCode})`,
        matchScore: score,
        status,
        tags: this.buildTags(summary, status, score),
      } as any;
    });

    return { rows, summary, firstRow: rows[0], error: null };
  }

  private buildTags(summary: AiMatchSummary, status: CandidateStatus, score: number): string[] {
    const safeSeniority = this.displaySeniority(summary.seniority || '', status, score);

    return [
      ...(summary.mainSkills?.length ? [`Kỹ năng: ${summary.mainSkills.slice(0, 3).join(', ')}`] : []),
      ...(summary.mainDomains?.length ? [`Lĩnh vực: ${summary.mainDomains.join(', ')}`] : []),
      `Cấp độ: ${this.seniorityLabel(safeSeniority)}`,
    ];
  }

  private buildCvLabel(res: any, fallbackName: string) {
    const email = res?.candidate?.email;
    const fullName = res?.candidate?.fullName;
    const fileName = res?.cvFile?.originalName || res?.cvFile?.filename || fallbackName;
    return String(email || fullName || fileName || fallbackName);
  }

  /* =========================
     LOAD FROM DB (single)
  ========================= */
  private loadAiResultFromDb(candidateId: string) {
    this.isLoadingFromDb = true;
    this.errorMessage = null;
    this.cdr.markForCheck();

    this.cvApi.getCandidateById(candidateId).subscribe({
      next: (candidate) => {
        this.isLoadingFromDb = false;

        if (!candidate) {
          this.resetUi('Không tìm thấy candidate trong DB.');
          return;
        }

        const mr = candidate.matchResult;
        if (!mr?.matches?.length) {
          this.resetUi('Candidate này chưa có kết quả AI (matchResult rỗng).');
          return;
        }

        // build giống upload
        const built = this.buildUiFromUploadResponse({ candidate, matchResult: mr });

        const key = String(candidate?._id || 'db');
        const label = String(candidate?.email || candidate?.fullName || 'Ứng viên');

        this.batchItems = [
          {
            key,
            label,
            rows: built.rows,
            summary: built.summary,
            firstRow: built.firstRow,
            error: built.error,
          },
        ];

        this.setActiveCv(key);

        this.saveState();
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.isLoadingFromDb = false;
        this.resetUi(err?.error?.message || 'Không load được candidate từ server.');
      },
    });
  }

  private resetUi(message: string) {
    this.errorMessage = message;

    this.batchItems = [];
    this.activeBatchKey = null;

    this.candidates = [];
    this.selectedCandidate = null;
    this.matchTags = [];
    this.matchSummary = null;

    this.saveState();
    this.cdr.detectChanges();
  }

  /* =========================
     TABLE SELECT (match row)
  ========================= */
  onSelectCandidate(row: CandidateRow) {
    this.selectedCandidate = row;
    this.matchTags = row.tags || [];
    // matchSummary giữ theo CV đang chọn (đúng filter)
    this.saveState();
  }

  private mapStatus(label: string, score: number): CandidateStatus {
    const normalized = (label || '').toLowerCase();
    if (normalized.includes('not') || normalized.includes('reject')) return 'NotFit';
    if (normalized.includes('potential')) return 'Potential';
    if (score >= 75) return 'Suitable';
    if (score >= 50) return 'Potential';
    return 'NotFit';
  }

  statusLabel(status: CandidateStatus | string): string {
    const map: Record<string, string> = {
      Suitable: 'Phù hợp',
      Potential: 'Tiềm năng',
      NotFit: 'Chưa phù hợp',
    };
    return map[String(status)] || String(status);
  }

  seniorityLabel(value: string): string {
    const v = (value || '').trim();
    const map: Record<string, string> = {
      Junior: 'Junior (Mới)',
      Mid: 'Middle (Có kinh nghiệm)',
      Senior: 'Senior (Chuyên sâu)',
      Lead: 'Lead (Trưởng nhóm)',
      Unknown: 'Chưa xác định',
    };
    return map[v] || v || 'Chưa xác định';
  }

  private displaySeniority(rawSeniority: string, status: CandidateStatus, score: number): string {
    const s = (rawSeniority || '').trim();
    if ((status === 'Potential' || status === 'NotFit') && s === 'Lead') return 'Mid';
    if (status === 'NotFit' && s === 'Senior') return 'Mid';
    return s || 'Unknown';
  }
}
