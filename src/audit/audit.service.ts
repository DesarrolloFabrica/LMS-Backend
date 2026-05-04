import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/sequelize";
import { Transaction } from "sequelize";
import { AuditLog } from "@/audit/models/audit-log.model";

export type FieldChange = {
  fieldName: string;
  oldValue?: unknown;
  newValue?: unknown;
};

@Injectable()
export class AuditService {
  constructor(@InjectModel(AuditLog) private readonly auditLogModel: typeof AuditLog) {}

  async logFieldChanges(subjectId: number, changedByUserId: number, changes: FieldChange[], transaction?: Transaction) {
    const rows = changes
      .filter((change) => this.serialize(change.oldValue) !== this.serialize(change.newValue))
      .map((change) => ({
        subjectId,
        fieldName: change.fieldName,
        oldValue: this.serialize(change.oldValue),
        newValue: this.serialize(change.newValue),
        changedByUserId,
      }));

    if (rows.length === 0) {
      return [];
    }

    return this.auditLogModel.bulkCreate(rows as AuditLog[], { transaction });
  }

  private serialize(value: unknown) {
    if (value === undefined || value === null) return null;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "string") return value;
    return JSON.stringify(value);
  }
}
