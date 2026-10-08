export interface ChargeRequest {
  order_id: string;
  amount_cents: number;
  idempotency_key: string;
}

export interface ChargeResponse {
  transaction_id: string;
  status: 'SUCCESS' | 'FAILED_INSUFFICIENT_FUNDS' | 'FAILED_DECLINED';
  code?: number;
  message?: string;
}

export interface ErrorResponse {
  error: string;
  message: string;
  status_code: number;
}
