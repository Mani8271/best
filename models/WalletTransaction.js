import { DataTypes } from "sequelize";
import { sequelize } from "../config/db.js";

const WalletTransaction = sequelize.define(
  "WalletTransaction",
  {
    walletId: { type: DataTypes.INTEGER, allowNull: false },

    type: {
      type: DataTypes.ENUM("CREDIT", "DEBIT"),
      allowNull: false,
    },

    amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },

    reason: {
      type: DataTypes.ENUM("TOPUP", "ORDER_PAYMENT", "REFUND",
        "REFERRAL_JOIN_BONUS",   // 5000
        "PAIR_BONUS",            // 3000 (self)
        "DOWNLINE_PAIR_BONUS",
        "WITHDRAWAL_REQUEST",    // User withdrawal request
        "WITHDRAWAL_REFUND"),   // Admin rejected, refund
      allowNull: false,
    },

    orderId: { type: DataTypes.INTEGER, allowNull: true },
    meta: { type: DataTypes.JSON, allowNull: true },

    // Withdrawal request fields
    status: {
      type: DataTypes.ENUM("PENDING", "APPROVED", "REJECTED"),
      allowNull: true,
      defaultValue: null,
    },
    bankDetails: { type: DataTypes.JSON, allowNull: true },
    adminNote: { type: DataTypes.TEXT, allowNull: true },
    transactionId: { type: DataTypes.STRING, allowNull: true },
    processedBy: { type: DataTypes.INTEGER, allowNull: true },
    processedAt: { type: DataTypes.DATE, allowNull: true },
  },
  { timestamps: true }
);

export default WalletTransaction;
