import { DataTypes } from "sequelize";
import { sequelize } from "../config/db.js";

const RankAchievement = sequelize.define(
  "RankAchievement",
  {
    userId: { type: DataTypes.INTEGER, allowNull: false },

    pairsRequired: { type: DataTypes.INTEGER, allowNull: false }, // 30
    pairsAtTime: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

    cashReward: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    giftName: { type: DataTypes.STRING(120), allowNull: true },

    walletTransactionId: { type: DataTypes.INTEGER, allowNull: true },

    achievedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },

    giftStatus: {
      type: DataTypes.ENUM("PENDING", "APPROVED", "DISPATCHED", "DELIVERED", "REJECTED"),
      allowNull: false,
      defaultValue: "PENDING",
    },

    // optional courier / notes
    meta: { type: DataTypes.JSON, allowNull: true },
  },
  {
    indexes: [
      { fields: ["userId", "pairsRequired"], unique: true }, // ✅ only once
      { fields: ["achievedAt"] },
      { fields: ["giftStatus"] },
    ],
  }
);

export default RankAchievement;
