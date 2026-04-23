import { DataTypes } from "sequelize";
import { sequelize } from "../config/db.js";

const PairMatch = sequelize.define(
  "PairMatch",
  {
    uplineUserId: { type: DataTypes.INTEGER, allowNull: false },

    leftUserId: { type: DataTypes.INTEGER, allowNull: false },
    rightUserId: { type: DataTypes.INTEGER, allowNull: false },

    bonusEach: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },

    walletTransactionId: { type: DataTypes.INTEGER, allowNull: true },
    matchedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    indexes: [
      { fields: ["uplineUserId", "matchedAt"] },
      { fields: ["leftUserId"] },
      { fields: ["rightUserId"] },
    ],
  }
);

export default PairMatch;
