import mongoose, { Schema, Model, Document } from "mongoose";

/* ------------------------------------------------------------------ */
/* 1 ▸  sub‑schema for every uploaded file                            */
/* ------------------------------------------------------------------ */
const File = new Schema(
  {
    fileId:       String,
    fileUniqueId: String,
    cloudUrl:     String,
    format:       String,              // jpg, png, pdf, …
    bytes:        Number,
    uploadedAt:  { type: Date, default: Date.now },
    verified:    { type: Boolean, default: false }
  },
  { _id: false }
);

/* ------------------------------------------------------------------ */
/* 2 ▸  main Driver schema                                            */
/* ------------------------------------------------------------------ */
const DriverSchema = new Schema(
  {
    fullName: String,
    phone:    String,
    chatId:   { type: String, index: true },
    telegramUsername: String,

    registrationStep: { type: String, default: "name" },   // name | phone | docs | completed
    status:           { type: String, default: "pending" },// pending | approved | …

    documents: {
      profilePhoto:        File,
      vehiclePhoto:        File,
      nationalId:          File,
      vehicleRegistration: File,
      driversLicense:      File,
      insuranceCertificate:File,
      pdpOrPsvBadge:       File,
      dekraCertificate:    File,
      policeClearance:     File,
      licenseDisc:         File
    }
  },
  { timestamps: true }
);

/* ------------------------------------------------------------------ */
/* 3 ▸  virtual: true if all 10 docs exist                            */
/* ------------------------------------------------------------------ */
DriverSchema.virtual("documentsComplete").get(function (this: any) {
  const keys = Object.keys(this.documents || {});
  return (
    keys.length === 10 &&
    keys.every((k) => this.documents[k] && this.documents[k].cloudUrl)
  );
});

/* ------------------------------------------------------------------ */
/* 4 ▸  instance method: add / replace one document                   */
/* ------------------------------------------------------------------ */
DriverSchema.methods.addOrUpdateDocument = function (
  this: any,
  key: keyof typeof this.documents,
  file: {
    fileId: string;
    fileUniqueId?: string;
    cloudUrl: string;
    format: string;
    bytes: number;
  }
) {
  this.documents[key] = {
    ...file,
    uploadedAt: new Date(),
    verified: false
  };
  return this.save();
};

/* ------------------------------------------------------------------ */
/* 5 ▸  statics                                                       */
/* ------------------------------------------------------------------ */
DriverSchema.statics.findByChatId = function (chatId: string) {
  return this.findOne({ chatId });
};
DriverSchema.statics.getStatusCounts = function () {
  return this.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]);
};

/* ------------------------------------------------------------------ */
/* 6 ▸  export                                                        */
/* ------------------------------------------------------------------ */
export interface DriverDocument extends Document {
  fullName?: string;
  phone?: string;
  chatId: string;
  telegramUsername?: string;
  registrationStep: string;
  status: string;
  documents: Record<string, typeof File>;
  documentsComplete: boolean;
  addOrUpdateDocument: (
    key: string,
    file: { fileId: string; fileUniqueId?: string; cloudUrl: string; format: string; bytes: number }
  ) => Promise<DriverDocument>;
}
export interface DriverModel extends Model<DriverDocument> {
  findByChatId(chatId: string): Promise<DriverDocument | null>;
  getStatusCounts(): Promise<{ _id: string; count: number }[]>;
}

export const Driver =
  (mongoose.models.Driver as DriverModel) ||
  mongoose.model<DriverDocument, DriverModel>("Driver", DriverSchema);
