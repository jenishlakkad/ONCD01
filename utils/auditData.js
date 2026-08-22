// Sample activity log consumed by AdminDashboard.dc.html (recent activity
// strip) and AdminAudit.dc.html (filterable report + CSV export).

export const AUDIT_LOG = [
  { date: '2026-08-05', time: '14:22', actor: 'Sofia Reyes', action: 'Approved user', target: 'Amelia Grant', module: 'Users' },
  { date: '2026-08-05', time: '11:03', actor: 'Sofia Reyes', action: 'Updated product', target: 'AC-D1042', module: 'Products' },
  { date: '2026-08-04', time: '16:47', actor: 'Marcus Webb', action: 'Uploaded media', target: 'IMG_1004.jpg', module: 'Media' },
  { date: '2026-08-04', time: '09:15', actor: 'Sofia Reyes', action: 'Added category', target: 'Exclusive Collection', module: 'Categories' },
  { date: '2026-08-03', time: '17:30', actor: 'Marcus Webb', action: 'Hid product', target: 'AC-J2244', module: 'Products' },
  { date: '2026-08-03', time: '10:02', actor: 'Sofia Reyes', action: 'Suspended user', target: 'Priya Nair', module: 'Users' },
  { date: '2026-08-02', time: '13:58', actor: 'Sofia Reyes', action: 'Updated SEO meta', target: 'Diamonds', module: 'SEO' },
  { date: '2026-08-02', time: '08:40', actor: 'Marcus Webb', action: 'Toggled homepage section', target: 'Spotlight banner', module: 'Homepage' },
  { date: '2026-08-01', time: '19:12', actor: 'Elena Cross', action: 'Edited role', target: 'Catalog Manager', module: 'Roles' },
  { date: '2026-08-01', time: '12:05', actor: 'Sofia Reyes', action: 'Added product', target: 'AC-G3009', module: 'Products' },
  { date: '2026-07-30', time: '15:44', actor: 'Marcus Webb', action: 'Rejected user', target: 'Tom Baker', module: 'Users' },
  { date: '2026-07-29', time: '10:50', actor: 'Sofia Reyes', action: 'Updated price visibility', target: 'Show Prices Only to Approved Users', module: 'Settings' },
  { date: '2026-07-28', time: '09:02', actor: 'Elena Cross', action: 'Added subcategory', target: 'Brooches', module: 'Categories' },
  { date: '2026-07-25', time: '14:16', actor: 'Sofia Reyes', action: 'Updated product', target: 'AC-J2201', module: 'Products' },
  { date: '2026-07-22', time: '11:30', actor: 'Marcus Webb', action: 'Uploaded media', target: 'IMG_1002.jpg', module: 'Media' },
  { date: '2026-07-20', time: '16:05', actor: 'Sofia Reyes', action: 'Approved user', target: 'Fatima Al-Sayed', module: 'Users' },
  { date: '2026-07-18', time: '13:22', actor: 'Elena Cross', action: 'Disabled product type', target: 'Videos feature', module: 'Product Types' },
  { date: '2026-07-15', time: '10:40', actor: 'Sofia Reyes', action: 'Updated SEO meta', target: 'Home', module: 'SEO' },
  { date: '2026-07-10', time: '17:55', actor: 'Marcus Webb', action: 'Edited slide', target: 'Hero slide 2', module: 'Homepage' },
  { date: '2026-07-05', time: '09:18', actor: 'Sofia Reyes', action: 'Added category', target: 'Lab Sapphire', module: 'Categories' },

  { date: '2026-06-27', time: '15:12', actor: 'Sofia Reyes', action: 'Suspended user', target: 'Wei Chen', module: 'Users' },
  { date: '2026-06-19', time: '11:47', actor: 'Elena Cross', action: 'Updated product', target: 'AC-D1120', module: 'Products' },
  { date: '2026-06-12', time: '14:03', actor: 'Marcus Webb', action: 'Uploaded media', target: 'IMG_1007.jpg', module: 'Media' },
  { date: '2026-06-04', time: '08:55', actor: 'Sofia Reyes', action: 'Edited role', target: 'Sales Support', module: 'Roles' },

  { date: '2026-05-29', time: '10:20', actor: 'Sofia Reyes', action: 'Approved user', target: 'Marco Rossi', module: 'Users' },
  { date: '2026-05-14', time: '16:38', actor: 'Marcus Webb', action: 'Updated SEO meta', target: 'Gemstones', module: 'SEO' },
  { date: '2026-05-02', time: '09:41', actor: 'Elena Cross', action: 'Added product', target: 'AC-G3004', module: 'Products' },

  { date: '2026-04-21', time: '13:10', actor: 'Sofia Reyes', action: 'Toggled homepage section', target: 'Newsletter banner', module: 'Homepage' },
  { date: '2026-04-08', time: '11:02', actor: 'Marcus Webb', action: 'Added category', target: 'CVD Jewelry', module: 'Categories' },

  { date: '2026-03-16', time: '15:47', actor: 'Sofia Reyes', action: 'Updated settings', target: 'WhatsApp Number', module: 'Settings' },
  { date: '2026-02-24', time: '10:33', actor: 'Elena Cross', action: 'Uploaded media', target: 'IMG_1000.jpg', module: 'Media' },
  { date: '2026-01-11', time: '09:00', actor: 'Sofia Reyes', action: 'Added product', target: 'AC-D1233', module: 'Products' },

  { date: '2025-11-19', time: '14:28', actor: 'Sofia Reyes', action: 'Approved user', target: 'Grant & Vance Jewelers', module: 'Users' },
  { date: '2025-09-06', time: '12:15', actor: 'Marcus Webb', action: 'Edited role', target: 'Content Editor', module: 'Roles' },
  { date: '2025-06-30', time: '17:05', actor: 'Elena Cross', action: 'Updated product', target: 'AC-J2244', module: 'Products' },
  { date: '2025-04-14', time: '10:52', actor: 'Sofia Reyes', action: 'Added category', target: 'Moissanite Jewelry', module: 'Categories' },
  { date: '2025-02-02', time: '08:47', actor: 'Marcus Webb', action: 'Updated SEO meta', target: 'Jewelry', module: 'SEO' },

  { date: '2024-12-18', time: '16:20', actor: 'Sofia Reyes', action: 'Suspended user', target: 'Test Account', module: 'Users' },
  { date: '2024-08-27', time: '13:33', actor: 'Elena Cross', action: 'Added product', target: 'AC-D1088', module: 'Products' },
  { date: '2024-05-09', time: '09:59', actor: 'Sofia Reyes', action: 'Updated settings', target: 'Support Email', module: 'Settings' },
  { date: '2024-02-15', time: '11:41', actor: 'Marcus Webb', action: 'Uploaded media', target: 'IMG_0994.jpg', module: 'Media' },
];
