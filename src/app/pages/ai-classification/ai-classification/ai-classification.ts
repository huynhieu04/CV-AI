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
  selectedFile: File | null = null;
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

    // ✅ load theo candidateId trên URL (kể cả refresh/restart)
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

  onFileChange(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];

    if (!file) {
      this.selectedFile = null;
      this.selectedFileName = null;
      return;
    }

    this.selectedFile = file;
    this.selectedFileName = file.name;
    this.errorMessage = null;
  }

  onRunMatching() {
    if (!this.selectedFile) {
      this.errorMessage = 'Vui lòng chọn một file CV trước khi chạy AI matching.';
      return;
    }

    this.isMatching = true;
    this.errorMessage = null;
    this.cdr.markForCheck();

    this.cvApi.uploadCv(this.selectedFile).subscribe({
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

    const filtered = matches.filter((m) => (m.score ?? 0) >= 10);
    if (!filtered.length) {
      return { rows: [], summary, firstRow: null, error: 'Không có vị trí nào đạt mức phù hợp tối thiểu (≥ 10%).' };
    }

    const name = res?.candidate?.email || res?.candidate?.fullName || 'Ứng viên đã upload';

    const rows: CandidateRow[] = filtered.map((m) => ({
      name,
      recommendedJob: `${m.jobTitle} (${m.jobCode})`,
      matchScore: m.score ?? 0,
      status: this.mapStatus(m.label, m.score),
      tags: this.buildTags(summary),
    }));

    return { rows, summary, firstRow: rows[0], error: null };
  }

  private buildTags(summary: AiMatchSummary): string[] {
    return [
      ...(summary.mainSkills?.length ? [`Kỹ năng: ${summary.mainSkills.slice(0, 3).join(', ')}`] : []),
      ...(summary.mainDomains?.length ? [`Lĩnh vực: ${summary.mainDomains.join(', ')}`] : []),
      `Cấp độ: ${this.seniorityLabel(summary.seniority || '')}`,
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
          .map((m: any) => ({
            name: candidate.email || candidate.fullName || 'Ứng viên',
            recommendedJob: `${m.jobTitle} (${m.jobCode})`,
            matchScore: m.score ?? 0,
            status: this.mapStatus(m.label, m.score),
            tags: this.buildTags(summary),
          }));

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
}
