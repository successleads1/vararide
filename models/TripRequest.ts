// backend/models/TripRequest.ts

import mongoose, { Document, Schema } from 'mongoose'

export interface TripRequestDocument extends Document {
  riderChatId: string
  riderName:   string
  riderCName?: string
  dropoff?:    string
  pickup:      { lat?: number; lon?: number }
  driverChatId?: string
  status:      'pending' | 'accepted' | 'completed' | 'cancelled'
  createdAt:   Date
  updatedAt:   Date
}

const TripRequestSchema = new Schema<TripRequestDocument>({
  riderChatId: { type: String, required: true },
  riderName:   { type: String, required: true },
  riderCName:  String,
  dropoff:     String,
  pickup: {
    lat: Number,
    lon: Number
  },
  driverChatId: String,
  status: {
    type: String,
    enum: ['pending','accepted','completed','cancelled'],
    default: 'pending'
  }
}, { timestamps: true })

export const TripRequest = mongoose.model<TripRequestDocument>(
  'TripRequest', TripRequestSchema
)
