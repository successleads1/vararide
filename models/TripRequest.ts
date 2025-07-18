// backend/models/TripRequest.ts
import { Schema, model, Document } from 'mongoose';

export interface TripRequestDocument extends Document {
  riderChatId: string;
  riderName: string;
  pickup: { lat: number; lon: number };
  dropoff?: string;
  status: 'pending' | 'accepted' | 'completed' | 'cancelled';
  driverChatId?: string;
  createdAt: Date;
}

const TripRequest = model<TripRequestDocument>(
  'TripRequest',
  new Schema({
    riderChatId: { type: String, required: true },
    riderName:   { type: String, required: true },
    pickup: {
      lat: { type: Number, required: true },
      lon: { type: Number, required: true },
    },
    dropoff:     String,
    status:      { type: String, enum: ['pending','accepted','completed','cancelled'], default: 'pending' },
    driverChatId:String,
  }, { timestamps: true })
);

export { TripRequest };
