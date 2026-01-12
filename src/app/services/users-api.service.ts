import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, map } from 'rxjs';

export type Role = 'HR' | 'ADMIN';

export interface AppUser {
    id: string;          // ✅ FE dùng id
    username: string;
    name: string;
    email: string;
    role: Role;
    createdAt: string;
}

const API_BASE = 'http://localhost:5000/api';

function toAppUser(u: any): AppUser {
    return {
        id: u.id || u._id,                 // ✅ map _id -> id
        username: u.username,
        name: u.name,
        email: u.email,
        role: u.role,
        createdAt: u.createdAt,
    };
}

@Injectable({ providedIn: 'root' })
export class UsersApiService {
    constructor(private http: HttpClient) { }

    list(): Observable<AppUser[]> {
        return this.http
            .get<any>(`${API_BASE}/users`, {
                params: { _ts: Date.now() }, // cache buster
                headers: new HttpHeaders({
                    'Cache-Control': 'no-cache',
                    Pragma: 'no-cache',
                }),
            })
            .pipe(map((res) => (res.users || []).map(toAppUser)));
    }

    create(payload: any): Observable<AppUser> {
        return this.http
            .post<any>(`${API_BASE}/users`, payload)
            .pipe(map((res) => toAppUser(res.user)));
    }

    update(id: string, payload: any): Observable<AppUser> {
        return this.http
            .patch<any>(`${API_BASE}/users/${id}`, payload)
            .pipe(map((res) => toAppUser(res.user)));
    }

    delete(id: string): Observable<void> {
        return this.http.delete<any>(`${API_BASE}/users/${id}`).pipe(map(() => void 0));
    }
}
