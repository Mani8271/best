const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/db.js");

const InvestmentTransaction = sequelize.define(
  "InvestmentTransaction",
  {
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    type: {
      type: DataTypes.ENUM("DEPOSIT", "MONTHLY_ROI", "LEVEL_COMMISSION", "WITHDRAWAL"),
      allowNull: false,
    },
    amount: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
    },
    level: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null, // 1, 2, 3, 4 for level commission
    },
    fromUserId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null, // User whose investment generated the commission
    },
    createdAdminId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
    },
    description: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    meta: {
      type: DataTypes.JSON,
      allowNull: true,
    },
  },
  {
    timestamps: true,
    indexes: [
      { fields: ["userId"] },
      { fields: ["type"] },
      { fields: ["fromUserId"] },
      { fields: ["createdAt"] },
    ],
  }
);

module.exports = InvestmentTransaction;
