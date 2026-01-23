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

@Component({
  selector: 'app-ai-classification',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './ai-classification.html',
  styleUrls: ['./ai-classification.scss'],
})
export class AiClassificationComponent implements OnInit {
  // ✅ NEW: multiple files
  selectedFiles: File[] = [];
  selectedFileName: string | null = null;

  isMatching = false;
  isLoadingFromDb = false;
  errorMessage: string | null = null;

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

    this.route.queryParams.subscribe((params) => {
      const candidateId = params['candidateId'];
      if (candidateId) this.loadAiResultFromDb(candidateId);
    });
  }

  private restoreState() {
    const snapshot = this.stateService.getSnapshot();
    if (!snapshot) return;

    this.candidates = snapshot.candidates;
    this.selectedCandidate = snapshot.selectedCandidate;
    this.matchTags = snapshot.matchTags;
    this.matchSummary = snapshot.matchSummary;
    this.errorMessage = snapshot.errorMessage;
  }

  private saveState() {
    const state: AiClassificationState = {
      candidates: this.candidates,
      selectedCandidate: this.selectedCandidate,
      matchTags: this.matchTags,
      matchSummary: this.matchSummary,
      errorMessage: this.errorMessage,
    };
    this.stateService.setState(state);
  }

  // ✅ NEW: multiple change handler
  onFilesChange(event: Event, inputEl?: HTMLInputElement) {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files || []);

    if (!files.length) {
      this.selectedFiles = [];
      this.selectedFileName = null;
      return;
    }

    // (optional) lọc trùng theo name+size (tránh user chọn trùng)
    const map = new Map<string, File>();
    for (const f of files) {
      map.set(`${f.name}-${f.size}`, f);
    }
    const uniqueFiles = Array.from(map.values());

    this.selectedFiles = uniqueFiles;

    // hiển thị tên file đẹp hơn
    if (uniqueFiles.length === 1) {
      this.selectedFileName = uniqueFiles[0].name;
    } else {
      const previewNames = uniqueFiles.slice(0, 2).map((f) => f.name).join(', ');
      const more = uniqueFiles.length > 2 ? ` +${uniqueFiles.length - 2} file` : '';
      this.selectedFileName = `${previewNames}${more}`;
    }

    this.errorMessage = null;

    // ✅ reset input để lần sau chọn lại cùng file vẫn trigger change
    if (inputEl) inputEl.value = '';
  }
  clearSelectedFiles() {
    this.selectedFiles = [];
    this.selectedFileName = null;
    this.errorMessage = null;
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

    // ✅ CASE 1: 1 file -> dùng flow cũ
    if (this.selectedFiles.length === 1) {
      const file = this.selectedFiles[0];

      this.cvApi.uploadCv(file).subscribe({
        next: (res: any) => {
          const { rows, summary, firstRow, error } = this.buildUiFromUploadResponse(res);

          this.matchSummary = summary;
          this.candidates = rows;
          this.selectedCandidate = firstRow;
          this.matchTags = firstRow?.tags || [];
          this.errorMessage = error;

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

    // ✅ CASE 2: nhiều file -> gọi batch
    this.cvApi.uploadCvBatch(this.selectedFiles).subscribe({
      next: (res: any) => {
        const results: any[] = Array.isArray(res?.results) ? res.results : [];

        // lấy item đầu tiên ok có matchResult
        const firstOk = results.find((x) => x?.ok && x?.matchResult);

        if (!firstOk) {
          this.isMatching = false;
          this.resetUi('Batch upload xong nhưng không có CV nào trả kết quả AI hợp lệ.');
          return;
        }

        // render UI theo CV đầu tiên ok (giữ nguyên UI hiện tại của bạn)
        const { rows, summary, firstRow, error } = this.buildUiFromUploadResponse(firstOk);

        this.matchSummary = summary;
        this.candidates = rows;
        this.selectedCandidate = firstRow;
        this.matchTags = firstRow?.tags || [];
        this.errorMessage = error || null;

        // nếu batch có file fail -> show thêm thông báo gợi ý (optional)
        const failed = results.filter((x) => !x?.ok);
        if (failed.length) {
          this.errorMessage =
            (this.errorMessage ? this.errorMessage + ' ' : '') +
            `(${failed.length}/${results.length} CV upload lỗi. Bạn kiểm tra định dạng/dung lượng.)`;
        }

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

        //  thêm field nội bộ để khi click row thì update summary đúng
        __summary: summary,
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

        const summaryRaw = mr.candidateSummary || {};
        const summary: AiMatchSummary = {
          mainSkills: summaryRaw.mainSkills || [],
          mainDomains: summaryRaw.mainDomains || [],
          seniority: summaryRaw.seniority || '',
        };
        this.matchSummary = summary;

        const rows: CandidateRow[] = mr.matches
          .slice()
          .sort((a: any, b: any) => (b.score ?? 0) - (a.score ?? 0))
          .map((m: any) => {
            const score = m.score ?? 0;
            const status = this.mapStatus(m.label, score);

            return {
              name: candidate.email || candidate.fullName || 'Ứng viên',
              recommendedJob: `${m.jobTitle} (${m.jobCode})`,
              matchScore: score,
              status,
              tags: this.buildTags(summary, status, score),
            };
          });

        this.candidates = rows;
        this.selectedCandidate = rows[0];
        this.matchTags = rows[0]?.tags || [];

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
    this.candidates = [];
    this.selectedCandidate = null;
    this.matchTags = [];
    this.matchSummary = null;
    this.saveState();
    this.cdr.detectChanges();
  }

  onSelectCandidate(candidate: CandidateRow) {
    this.selectedCandidate = candidate;
    this.matchTags = candidate.tags;

    // ✅ update summary theo row (nếu có)
    const anyCandidate = candidate as any;
    if (anyCandidate?.__summary) this.matchSummary = anyCandidate.__summary;

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
