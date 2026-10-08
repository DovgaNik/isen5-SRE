export interface OrderItem {
  product_id: string;
  quantity: number;
}

export interface CheckoutRequest {
  user_id: string;
  items: OrderItem[];
  payment_method: string;
}

export interface CheckoutResponse {
  order_id: string;
  status: 'CONFIRMED' | 'FAILED';
  total_cents?: number;
  reservation_id?: string;
  transaction_id?: string;
  message?: string;
}

export interface ErrorResponse {
  error: string;
  message: string;
  status_code: number;
}
