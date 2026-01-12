// src/app/pages/candidates/candidates/candidates.ts
import { CommonModule } from '@angular/common';
import {
  Component,
  OnInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  OnDestroy,
} from '@angular/core';
import { RouterModule } from '@angular/router';
import { Subject, takeUntil } from 'rxjs';

import { CvApiService } from '../../../services/cv-api.service';
import { GlobalSearchService } from '../../../services/global-search.service';

type CandidateStatus = 'Suitable' | 'Potential' | 'NotFit';

interface CandidateRow {
  stt: number; // ✅ để search theo STT
  candidateId: string;
  name: string;
  email: string;

  bestJobId: string | null;
  bestJob: string;

  matchScore: number;
  status: CandidateStatus;
  createdAt: string;
}

@Component({
  selector: 'app-candidates',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './candidates.html',
  styleUrls: ['./candidates.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CandidatesComponent implements OnInit, OnDestroy {
  private destroy$ = new Subject<void>();

  isLoading = false;
  errorMessage: string | null = null;

  rows: CandidateRow[] = [];
  filteredRows: CandidateRow[] = [];

  private q = '';

  constructor(
    private cvApi: CvApiService,
    private cdr: ChangeDetectorRef,
    private globalSearch: GlobalSearchService
  ) { }

  ngOnInit(): void {
    // ✅ Nhận keyword từ ô search trên HEADER
    this.globalSearch.term$
      .pipe(takeUntil(this.destroy$))
      .subscribe((term) => {
        this.q = (term || '').trim().toLowerCase();
        this.applyFilter();
      });

    this.loadCandidates();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  loadCandidates() {
    this.isLoading = true;
    this.errorMessage = null;
    this.cdr.markForCheck();

    this.cvApi.getCandidates().subscribe({
      next: (list: any) => {
        const arr: any[] = Array.isArray(list) ? list : [];

        this.rows = arr.map((c, idx) => {
          const matchResult = c.matchResult || {};
          const matches: any[] = Array.isArray(matchResult.matches)
            ? matchResult.matches
            : [];

          let best: any | null = null;

          if (matches.length) {
            if (matchResult.bestJobId) {
              best =
                matches.find(
                  (m) => String(m.jobId) === String(matchResult.bestJobId)
                ) ?? matches[0];
            } else {
              best = [...matches].sort(
                (a, b) => (b.score ?? 0) - (a.score ?? 0)
              )[0];
            }
          }

          const score = best?.score ?? 0;
          const label = best?.label || '';

          return {
            stt: idx + 1, // ✅ STT thật
            candidateId: c._id,
            name: c.fullName || c.name || 'Candidate from CV',
            email: c.email || 'candidate@example.com',
            bestJobId: best?.jobId ?? null,
            bestJob: best ? `${best.jobTitle} (${best.jobCode})` : 'Chưa có gợi ý',
            matchScore: score,
            status: this.mapStatus(label, score),
            createdAt: c.createdAt,
          };
        });

        this.isLoading = false;

        // ✅ apply theo keyword hiện tại trên header (nếu đang có)
        this.applyFilter();

        this.cdr.markForCheck();
      },
      error: (err) => {
        this.errorMessage =
          err?.error?.message ||
          'Không tải được danh sách candidate từ server. Vui lòng kiểm tra backend.';
        this.isLoading = false;
        this.cdr.markForCheck();
      },
    });
  }

  private applyFilter() {
    const q = this.q;

    if (!q) {
      this.filteredRows = [...this.rows];
      this.cdr.markForCheck();
      return;
    }

    this.filteredRows = this.rows.filter((c) => {
      const statusVi = this.statusLabel(c.status).toLowerCase();
      const created = this.formatDateForSearch(c.createdAt);

      return (
        // ✅ STT: gõ "1" sẽ ra STT 1,10,11...
        String(c.stt).includes(q) ||

        c.candidateId.toLowerCase().includes(q) ||
        c.email.toLowerCase().includes(q) ||
        c.name.toLowerCase().includes(q) ||
        c.bestJob.toLowerCase().includes(q) ||
        String(c.bestJobId || '').toLowerCase().includes(q) ||
        String(c.matchScore ?? '').includes(q) ||
        String(c.status || '').toLowerCase().includes(q) ||
        statusVi.includes(q) ||

        // ✅ gõ "18/12" sẽ match dd/MM/yyyy
        created.includes(q)
      );
    });

    this.cdr.markForCheck();
  }

  private formatDateForSearch(iso: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = String(d.getFullYear());
    return `${dd}/${mm}/${yyyy}`.toLowerCase();
  }

  private mapStatus(label: string, score: number): CandidateStatus {
    const normalized = (label || '').toLowerCase();
    if (normalized.includes('not fit') || normalized.includes('reject')) return 'NotFit';
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

  onDeleteCandidate(candidateId: string, ev?: MouseEvent) {
    ev?.stopPropagation(); // ✅ không trigger click row/link

    const ok = window.confirm('Bạn chắc chắn muốn xoá hồ sơ này? Hành động này không thể hoàn tác.');
    if (!ok) return;

    this.cvApi.deleteCandidate(candidateId).subscribe({
      next: () => {
        // ✅ xoá khỏi rows và filteredRows luôn (nhanh, không cần reload)
        this.rows = this.rows.filter(r => r.candidateId !== candidateId);
        this.applyFilter();
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.errorMessage = err?.error?.message || 'Xoá candidate thất bại.';
        this.cdr.markForCheck();
      }
    });
  }

}
