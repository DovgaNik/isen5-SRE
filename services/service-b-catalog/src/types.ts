export interface Product {
  id: string;
  name: string;
  price_cents: number;
  stock: number;
}

export interface ReservationItem {
  product_id: string;
  quantity: number;
}

export interface ReserveRequest {
  items: ReservationItem[];
}

export interface ReserveResponse {
  reservation_id: string;
  status: 'reserved' | 'conflict';
  message?: string;
}

export interface ReleaseRequest {
  reservation_id: string;
}

export interface ReleaseResponse {
  reservation_id: string;
  status: 'released';
}

export interface ErrorResponse {
  error: string;
  message: string;
  status_code: number;
}
