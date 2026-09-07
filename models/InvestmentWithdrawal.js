const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/db.js");

const InvestmentWithdrawal = sequelize.define(
  "InvestmentWithdrawal",
  {
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    investmentId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    amount: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM("PENDING", "APPROVED", "REJECTED"),
      allowNull: false,
      defaultValue: "PENDING",
    },
    bankAccountNumber: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    ifscCode: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    accountHolderName: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    bankName: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    utrNumber: {
      type: DataTypes.STRING(100),
      allowNull: true, // Bank UTR or Transaction reference entered by admin
    },
    adminRemark: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    processedByAdminId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    processedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    timestamps: true,
    indexes: [
      { fields: ["userId"] },
      { fields: ["status"] },
      { fields: ["createdAt"] },
    ],
  }
);

module.exports = InvestmentWithdrawal;
